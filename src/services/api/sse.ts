/**
 * 解析 Server-Sent Events 流
 */
export async function parseSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string | null) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData: string | null = null;

  const flush = () => {
    if (currentEvent && (currentData !== null || currentEvent === 'done')) {
      onEvent(currentEvent, currentData);
    }
    currentEvent = '';
    currentData = null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          flush();
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentData = line.slice(5).trim();
        } else if (line === '') {
          flush();
        }
      }
    }
    if (buffer.trim()) {
      if (buffer.startsWith('event:')) {
        flush();
        currentEvent = buffer.slice(6).trim();
      } else if (buffer.startsWith('data:')) {
        currentData = buffer.slice(5).trim();
      }
      flush();
    }
  } finally {
    reader.releaseLock();
  }
}
