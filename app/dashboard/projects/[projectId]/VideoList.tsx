"use client";

import { useEffect, useRef, useState } from "react";
import type { Clip, ClipStatus, Transcription, Video, VideoStatus } from "@prisma/client";
import { CLIP_STATUS_LABELS, VIDEO_STATUS_LABELS } from "@/lib/video-status";

type VideoWithRelations = Video & {
  transcription: Transcription | null;
  clips: Clip[];
};

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

const POLLING_VIDEO_STATUSES: VideoStatus[] = ["UPLOADING", "TRANSCRIBING"];
const POLLING_CLIP_STATUSES: ClipStatus[] = ["PENDING", "GENERATING"];

function hasPendingWork(videos: VideoWithRelations[]) {
  return videos.some(
    (video) =>
      POLLING_VIDEO_STATUSES.includes(video.status) ||
      (video.status === "UPLOADED" && !video.transcription) ||
      video.clips.some((clip) => POLLING_CLIP_STATUSES.includes(clip.status))
  );
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function VideoCard({
  projectId,
  video,
  onClipCreated,
  onClipUpdated,
  onClipDeleted,
}: {
  projectId: string;
  video: VideoWithRelations;
  onClipCreated: (videoId: string, clip: Clip) => void;
  onClipUpdated: (videoId: string, clip: Clip) => void;
  onClipDeleted: (videoId: string, clipId: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [selection, setSelection] = useState<{
    start: number | null;
    end: number | null;
  }>({ start: null, end: null });
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ title: "", start: "", end: "" });
  const [savingClipId, setSavingClipId] = useState<string | null>(null);
  const [deletingClipId, setDeletingClipId] = useState<string | null>(null);

  const segments = (video.transcription?.segments ?? []) as unknown as TranscriptSegment[];
  const hasValidSelection =
    selection.start != null && selection.end != null && selection.end > selection.start;

  function seekTo(time: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  }

  function markStart() {
    if (!videoRef.current) return;
    setSelection((s) => ({ ...s, start: videoRef.current!.currentTime }));
  }

  function markEnd() {
    if (!videoRef.current) return;
    setSelection((s) => ({ ...s, end: videoRef.current!.currentTime }));
  }

  function handlePreview() {
    if (selection.start == null || selection.end == null || !videoRef.current) return;
    videoRef.current.currentTime = selection.start;
    setPreviewing(true);
    videoRef.current.play();
  }

  function handleTimeUpdate() {
    if (
      previewing &&
      videoRef.current &&
      selection.end != null &&
      videoRef.current.currentTime >= selection.end
    ) {
      videoRef.current.pause();
      setPreviewing(false);
    }
  }

  async function handleCreateClip() {
    if (!hasValidSelection) return;

    setCreating(true);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/videos/${video.id}/clips`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startTime: selection.start,
            endTime: selection.end,
            title,
          }),
        }
      );

      if (response.ok) {
        onClipCreated(video.id, await response.json());
        setSelection({ start: null, end: null });
        setTitle("");
      }
    } finally {
      setCreating(false);
    }
  }

  function startEditing(clip: Clip) {
    setEditingClipId(clip.id);
    setEditValues({
      title: clip.title ?? "",
      start: clip.startTime.toString(),
      end: clip.endTime.toString(),
    });
  }

  async function saveEdit(clipId: string) {
    setSavingClipId(clipId);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/videos/${video.id}/clips/${clipId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: editValues.title,
            startTime: Number(editValues.start),
            endTime: Number(editValues.end),
          }),
        }
      );

      if (response.ok) {
        onClipUpdated(video.id, await response.json());
        setEditingClipId(null);
      }
    } finally {
      setSavingClipId(null);
    }
  }

  async function deleteClip(clipId: string) {
    if (!window.confirm("Excluir este clipe?")) return;

    setDeletingClipId(clipId);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/videos/${video.id}/clips/${clipId}`,
        { method: "DELETE" }
      );

      if (response.ok || response.status === 204) {
        onClipDeleted(video.id, clipId);
      }
    } finally {
      setDeletingClipId(null);
    }
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow">
      <h3 className="font-semibold">{video.originalFilename}</h3>

      <p className="mt-2 text-sm text-gray-500">
        {VIDEO_STATUS_LABELS[video.status]}
      </p>

      {video.storagePath && (
        <video
          ref={videoRef}
          src={`/api/projects/${projectId}/videos/${video.id}/stream`}
          controls
          onTimeUpdate={handleTimeUpdate}
          className="mt-3 w-full rounded bg-black"
        />
      )}

      {video.transcription && (
        <>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-gray-600">
              Navegar pela transcrição
            </summary>

            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {segments.map((segment, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => seekTo(segment.start)}
                  className="block w-full rounded p-1 text-left text-gray-700 hover:bg-gray-100"
                >
                  <span className="mr-2 text-xs text-gray-400">
                    {formatTime(segment.start)}
                  </span>
                  {segment.text}
                </button>
              ))}
            </div>
          </details>

          <div className="mt-3 space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={markStart}
                className="rounded border px-2 py-1"
              >
                Marcar início
              </button>

              <button
                type="button"
                onClick={markEnd}
                className="rounded border px-2 py-1"
              >
                Marcar fim
              </button>

              <span className="text-gray-600">
                {selection.start != null ? formatTime(selection.start) : "--:--"} –{" "}
                {selection.end != null ? formatTime(selection.end) : "--:--"}
              </span>
            </div>

            {hasValidSelection && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handlePreview}
                  className="rounded border px-2 py-1"
                >
                  Pré-visualizar
                </button>

                <input
                  type="text"
                  placeholder="Título do clipe (opcional)"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="rounded border px-2 py-1"
                />

                <button
                  type="button"
                  disabled={creating}
                  onClick={handleCreateClip}
                  className="rounded bg-black px-3 py-1 text-white disabled:opacity-40"
                >
                  {creating ? "Criando..." : "Criar clipe"}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {video.clips.length > 0 && (
        <div className="mt-4 space-y-3 border-t pt-3">
          {video.clips.map((clip) => (
            <div key={clip.id} className="text-sm">
              {editingClipId === clip.id ? (
                <div className="space-y-1 rounded border p-2">
                  <input
                    type="text"
                    value={editValues.title}
                    onChange={(e) =>
                      setEditValues((v) => ({ ...v, title: e.target.value }))
                    }
                    placeholder="Título"
                    className="w-full rounded border px-2 py-1"
                  />

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      step="0.1"
                      value={editValues.start}
                      onChange={(e) =>
                        setEditValues((v) => ({ ...v, start: e.target.value }))
                      }
                      className="w-20 rounded border px-2 py-1"
                    />
                    <span>–</span>
                    <input
                      type="number"
                      step="0.1"
                      value={editValues.end}
                      onChange={(e) =>
                        setEditValues((v) => ({ ...v, end: e.target.value }))
                      }
                      className="w-20 rounded border px-2 py-1"
                    />

                    <button
                      type="button"
                      disabled={savingClipId === clip.id}
                      onClick={() => saveEdit(clip.id)}
                      className="rounded bg-black px-2 py-1 text-white disabled:opacity-40"
                    >
                      Salvar
                    </button>

                    <button
                      type="button"
                      onClick={() => setEditingClipId(null)}
                      className="rounded border px-2 py-1"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-600">
                    {clip.title ? `${clip.title} · ` : ""}
                    {formatTime(clip.startTime)} – {formatTime(clip.endTime)}{" "}
                    <span className="text-gray-400">
                      ({CLIP_STATUS_LABELS[clip.status]})
                    </span>
                  </span>

                  <div className="flex items-center gap-3">
                    {clip.status === "COMPLETED" && (
                      <a
                        href={`/api/projects/${projectId}/videos/${video.id}/clips/${clip.id}/download`}
                        className="text-blue-600 hover:underline"
                      >
                        Baixar
                      </a>
                    )}

                    <button
                      type="button"
                      onClick={() => startEditing(clip)}
                      className="text-gray-600 hover:underline"
                    >
                      Editar
                    </button>

                    <button
                      type="button"
                      disabled={deletingClipId === clip.id}
                      onClick={() => deleteClip(clip.id)}
                      className="text-red-600 hover:underline disabled:opacity-40"
                    >
                      Excluir
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function VideoList({
  projectId,
  initialVideos,
}: {
  projectId: string;
  initialVideos: VideoWithRelations[];
}) {
  const [videos, setVideos] = useState(initialVideos);
  const videosRef = useRef(videos);

  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);

  useEffect(() => {
    setVideos(initialVideos);
  }, [initialVideos]);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!hasPendingWork(videosRef.current)) {
        return;
      }

      const response = await fetch(`/api/projects/${projectId}/videos`);

      if (!response.ok) return;

      setVideos(await response.json());
    }, 3000);

    return () => clearInterval(interval);
  }, [projectId]);

  function handleClipCreated(videoId: string, clip: Clip) {
    setVideos((prev) =>
      prev.map((video) =>
        video.id === videoId
          ? { ...video, clips: [clip, ...video.clips] }
          : video
      )
    );
  }

  function handleClipUpdated(videoId: string, clip: Clip) {
    setVideos((prev) =>
      prev.map((video) =>
        video.id === videoId
          ? {
              ...video,
              clips: video.clips.map((c) => (c.id === clip.id ? clip : c)),
            }
          : video
      )
    );
  }

  function handleClipDeleted(videoId: string, clipId: string) {
    setVideos((prev) =>
      prev.map((video) =>
        video.id === videoId
          ? { ...video, clips: video.clips.filter((c) => c.id !== clipId) }
          : video
      )
    );
  }

  if (videos.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-dashed bg-white p-10 text-center">
        <p className="text-gray-600">
          Este projeto ainda não possui vídeos.
        </p>

        <p className="mt-2 text-sm text-gray-400">
          Envie seu primeiro vídeo para começar.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {videos.map((video) => (
        <VideoCard
          key={video.id}
          projectId={projectId}
          video={video}
          onClipCreated={handleClipCreated}
          onClipUpdated={handleClipUpdated}
          onClipDeleted={handleClipDeleted}
        />
      ))}
    </div>
  );
}
