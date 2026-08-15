"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Project = {
  id: string;
  name: string;
  createdAt: string;
};

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadProjects() {
    const response = await fetch("/api/projects");

    if (!response.ok) {
      setError("Não foi possível carregar os projetos.");
      return;
    }

    const data = await response.json();
    setProjects(data);
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) return;

    setLoading(true);
    setError("");

    const response = await fetch("/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      setError(data.error || "Erro ao criar projeto.");
      setLoading(false);
      return;
    }

    setProjects((current) => [data, ...current]);
    setName("");
    setShowForm(false);
    setLoading(false);
  }

  useEffect(() => {
    loadProjects();
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">
              ClipForge AI
            </h1>

            <p className="mt-2 text-gray-600">
              Transforme vídeos longos em clips automaticamente.
            </p>
          </div>

          <button
            onClick={() => setShowForm(!showForm)}
            className="rounded-lg bg-black px-5 py-3 text-white"
          >
            + Novo projeto
          </button>
        </div>

        {showForm && (
          <form
            onSubmit={createProject}
            className="mt-8 rounded-xl bg-white p-6 shadow"
          >
            <h2 className="text-xl font-semibold">
              Novo projeto
            </h2>

            <input
              type="text"
              placeholder="Nome do projeto"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-4 w-full rounded-lg border p-3"
              required
            />

            {error && (
              <p className="mt-3 text-sm text-red-600">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-black px-5 py-3 text-white disabled:opacity-50"
              >
                {loading ? "Criando..." : "Criar projeto"}
              </button>

              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg border px-5 py-3"
              >
                Cancelar
              </button>
            </div>
          </form>
        )}

        <section className="mt-10">
          <h2 className="text-xl font-semibold">
            Meus projetos
          </h2>

          {projects.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed bg-white p-10 text-center">
              <p className="text-gray-600">
                Você ainda não possui projetos.
              </p>

              <p className="mt-2 text-sm text-gray-400">
                Crie seu primeiro projeto para começar.
              </p>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/dashboard/projects/${project.id}`}
                  className="block rounded-xl bg-white p-6 shadow transition hover:shadow-md"
                >
                  <h3 className="font-semibold">
                    {project.name}
                  </h3>

                  <p className="mt-2 text-sm text-gray-500">
                    Criado em{" "}
                    {new Date(project.createdAt).toLocaleDateString(
                      "pt-BR"
                    )}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
