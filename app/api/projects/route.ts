import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json(
      { error: "Não autenticado" },
      { status: 401 }
    );
  }

  const body = await request.json();
  const name = body.name?.trim();

  if (!name) {
    return Response.json(
      { error: "O nome do projeto é obrigatório" },
      { status: 400 }
    );
  }

  const project = await prisma.project.create({
    data: {
      name,
      userId: session.user.id,
    },
  });

  return Response.json(project, { status: 201 });
}
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json(
      { error: "Não autenticado" },
      { status: 401 }
    );
  }

  const projects = await prisma.project.findMany({
    where: {
      userId: session.user.id,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return Response.json(projects);
}
