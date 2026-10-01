// Process lifecycle state shared by the server (which flips it) and /readyz (which reports it).
let shuttingDown = false;

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
