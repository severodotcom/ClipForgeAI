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
      video.clips.some((clip) => POLLING_CLIP_STATUSES.includes(clip.status))
  );
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
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
  const [selection, setSelection] = useState<
    Record<string, { start: number; end: number } | { start: number } | undefined>
  >({});
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);

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

  function handleSegmentClick(videoId: string, segment: TranscriptSegment) {
    setSelection((prev) => {
      const current = prev[videoId];

      if (!current || "end" in current) {
        return { ...prev, [videoId]: { start: segment.start } };
      }

      if (segment.end <= current.start) {
        return { ...prev, [videoId]: { start: segment.start } };
      }

      return { ...prev, [videoId]: { start: current.start, end: segment.end } };
    });
  }

  async function handleCreateClip(videoId: string) {
    const current = selection[videoId];

    if (!current || !("end" in current)) return;

    setCreating(videoId);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/videos/${videoId}/clips`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startTime: current.start,
            endTime: current.end,
          }),
        }
      );

      if (response.ok) {
        const clip = await response.json();

        setVideos((prev) =>
          prev.map((video) =>
            video.id === videoId
              ? { ...video, clips: [clip, ...video.clips] }
              : video
          )
        );
        setSelection((prev) => ({ ...prev, [videoId]: undefined }));
      }
    } finally {
      setCreating(null);
    }
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
      {videos.map((video) => {
        const segments = (video.transcription?.segments ?? []) as unknown as TranscriptSegment[];
        const current = selection[video.id];

        return (
          <div key={video.id} className="rounded-xl bg-white p-6 shadow">
            <h3 className="font-semibold">{video.originalFilename}</h3>

            <p className="mt-2 text-sm text-gray-500">
              {VIDEO_STATUS_LABELS[video.status]}
            </p>

            {video.transcription && (
              <>
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-gray-600">
                    Selecionar trecho para clipe
                  </summary>

                  <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                    {segments.map((segment, index) => {
                      const isSelected =
                        current &&
                        segment.start >= current.start &&
                        segment.end <= ("end" in current ? current.end : current.start);

                      return (
                        <button
                          key={index}
                          type="button"
                          onClick={() => handleSegmentClick(video.id, segment)}
                          className={`block w-full rounded p-1 text-left text-gray-700 hover:bg-gray-100 ${
                            isSelected ? "bg-blue-100" : ""
                          }`}
                        >
                          <span className="mr-2 text-xs text-gray-400">
                            {formatTime(segment.start)}
                          </span>
                          {segment.text}
                        </button>
                      );
                    })}
                  </div>
                </details>

                {current && (
                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <span className="text-gray-600">
                      {formatTime(current.start)} –{" "}
                      {"end" in current ? formatTime(current.end) : "?"}
                    </span>

                    <button
                      type="button"
                      disabled={!("end" in current) || creating === video.id}
                      onClick={() => handleCreateClip(video.id)}
                      className="rounded bg-black px-3 py-1 text-white disabled:opacity-40"
                    >
                      {creating === video.id ? "Criando..." : "Criar clipe"}
                    </button>
                  </div>
                )}
              </>
            )}

            {video.clips.length > 0 && (
              <div className="mt-4 space-y-2 border-t pt-3">
                {video.clips.map((clip) => (
                  <div
                    key={clip.id}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-gray-600">
                      {formatTime(clip.startTime)} – {formatTime(clip.endTime)}{" "}
                      <span className="text-gray-400">
                        ({CLIP_STATUS_LABELS[clip.status]})
                      </span>
                    </span>

                    {clip.status === "COMPLETED" && (
                      <a
                        href={`/api/projects/${projectId}/videos/${video.id}/clips/${clip.id}/download`}
                        className="text-blue-600 hover:underline"
                      >
                        Baixar
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
