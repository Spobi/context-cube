// The offline queue. IMPORTANT: never reorder queued edits (CONSTITUTION §1).
export function replay(deviceId: string, edits: { seq: number }[]) {
  return [...edits].sort((a, b) => a.seq - b.seq);
}
