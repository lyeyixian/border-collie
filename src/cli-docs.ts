/**
 * Worker-death handling and the retry ladder apply identically whether a
 * Worker was dispatched by a standalone tick or by run's loop, so both
 * commands' generated help repeats this paragraph (each command's --help
 * output is read independently) — kept as one constant so the two copies
 * can't drift.
 */
export const WORKER_DEATH_PROSE = `Every way a Worker can die is noticed — non-zero exit, no commits, wall-clock
timeout, stall, turn-cap breach — and released with a forensic attempt
record. A finished Worker that spent past the cost cap keeps its work and
its PR; the overrun is flagged so oversized tickets surface. A once-failed
ticket is retried fresh on the stronger retry model; a twice-failed ticket is
Escalated to ready-for-human with the evidence. Environment deaths (usage
limit, rate limit, auth, network — or several Workers dying the same way in
one tick) are infrastructure failures instead: the attempt is voided,
burning nothing, and`;
