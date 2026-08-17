import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UploadVideoForm } from "./UploadVideoForm";
import { VideoList } from "./VideoList";

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
        include: {
          transcription: true,
          clips: { orderBy: { createdAt: "desc" } },
        },
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

          <VideoList projectId={project.id} initialVideos={project.videos} />
        </section>
      </div>
    </main>
  );
}
