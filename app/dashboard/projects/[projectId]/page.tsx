import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UploadVideoForm } from "./UploadVideoForm";

export default async function ProjectPage({
  params,
}: PageProps<"/dashboard/projects/[projectId]">) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/login");
  }

  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      videos: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!project || project.userId !== session.user.id) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="text-sm text-gray-500 hover:text-black"
        >
          ← Voltar para o dashboard
        </Link>

        <div className="mt-4">
          <h1 className="text-3xl font-bold">{project.name}</h1>

          <p className="mt-2 text-gray-600">
            Criado em{" "}
            {new Date(project.createdAt).toLocaleDateString("pt-BR")}
          </p>
        </div>

        <section className="mt-10">
          <h2 className="text-xl font-semibold">Vídeos</h2>

          <UploadVideoForm projectId={project.id} />

          {project.videos.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed bg-white p-10 text-center">
              <p className="text-gray-600">
                Este projeto ainda não possui vídeos.
              </p>

              <p className="mt-2 text-sm text-gray-400">
                Envie seu primeiro vídeo para começar.
              </p>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {project.videos.map((video) => (
                <div
                  key={video.id}
                  className="rounded-xl bg-white p-6 shadow"
                >
                  <h3 className="font-semibold">
                    {video.originalFilename}
                  </h3>

                  <p className="mt-2 text-sm text-gray-500">
                    {video.status}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
