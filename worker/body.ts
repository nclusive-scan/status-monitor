// Reading a response body with a byte cap. A Content-Length check alone does not bound memory: a chunked or compressed
// response has none (or a false one), and Response.text() would buffer all of it first. This reads chunk by chunk and
// cancels the stream as soon as the cap is passed.

/** Reads at most `max` bytes of a body; null (and the stream cancelled) when it is longer. */
export async function readCapped(response: Response, max: number): Promise<string | null> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
