"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function UploadVideoForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const file = inputRef.current?.files?.[0];

    if (!file) return;

    setUploading(true);
    setError("");

    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(`/api/projects/${projectId}/videos`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setError(data?.error || "Erro ao enviar o vídeo.");
      setUploading(false);
      return;
    }

    if (inputRef.current) {
      inputRef.current.value = "";
    }

    setUploading(false);
    router.refresh();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 flex flex-col gap-3 rounded-xl bg-white p-6 shadow sm:flex-row sm:items-center"
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        required
        className="flex-1 text-sm"
      />

      <button
        type="submit"
        disabled={uploading}
        className="rounded-lg bg-black px-5 py-3 text-white disabled:opacity-50"
      >
        {uploading ? "Enviando..." : "Enviar vídeo"}
      </button>

      {error && (
        <p className="text-sm text-red-600 sm:ml-3">{error}</p>
      )}
    </form>
  );
}
