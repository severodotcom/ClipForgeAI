import { auth } from "@/lib/auth";

export async function GET(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    return Response.json(
      { authenticated: false },
      { status: 401 }
    );
  }

  return Response.json({
    authenticated: true,
    user: session.user,
  });
}
