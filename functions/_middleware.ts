export const onRequest: PagesFunction = async () => {
  return new Response("Service temporarily unavailable.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
