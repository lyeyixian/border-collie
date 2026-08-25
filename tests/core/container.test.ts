import { describe, expect, it } from "vitest";
import {
  ATTEMPT_LABEL,
  encodeSessionLabels,
  parseSessionLabels,
  REPOSITORY_LABEL,
  type SessionLabels,
  TICKET_LABEL,
  type TranscriptFile,
  ticketFromTranscriptFileName,
  transcriptHostDir,
  transcriptsToPrune,
} from "../../src/core/container.js";

const SESSION: SessionLabels = {
  repository: "acme/widgets",
  ticket: 42,
  attempt: 2,
};

/** What `docker ps --format '{{.Labels}}'` prints for one container: its whole label set, comma-joined. */
function asDockerLabelsField(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

describe("encodeSessionLabels / parseSessionLabels", () => {
  it("round-trips a session's identity through docker's own comma-joined labels field", () => {
    const raw = asDockerLabelsField(encodeSessionLabels(SESSION));

    expect(parseSessionLabels(raw)).toEqual(SESSION);
  });

  it("ignores labels docker or an operator added alongside ours", () => {
    const raw = `com.docker.compose.project=fleet,${asDockerLabelsField(encodeSessionLabels(SESSION))},maintainer=ops`;

    expect(parseSessionLabels(raw)).toEqual(SESSION);
  });

  it("parses nothing from a container that carries none of our labels", () => {
    expect(
      parseSessionLabels("com.docker.compose.project=fleet"),
    ).toBeUndefined();
  });

  it("parses nothing from an empty labels field", () => {
    expect(parseSessionLabels("")).toBeUndefined();
  });

  it("parses nothing when the repository label is missing", () => {
    const labels = encodeSessionLabels(SESSION);
    delete (labels as Record<string, string | undefined>)[REPOSITORY_LABEL];

    expect(parseSessionLabels(asDockerLabelsField(labels))).toBeUndefined();
  });

  it("parses nothing when the ticket label is not a plain integer", () => {
    const raw = `${REPOSITORY_LABEL}=acme/widgets,${TICKET_LABEL}=not-a-number,${ATTEMPT_LABEL}=2`;

    expect(parseSessionLabels(raw)).toBeUndefined();
  });

  it("parses nothing when the attempt label is not a plain integer", () => {
    const raw = `${REPOSITORY_LABEL}=acme/widgets,${TICKET_LABEL}=42,${ATTEMPT_LABEL}=two`;

    expect(parseSessionLabels(raw)).toBeUndefined();
  });
});

describe("transcriptHostDir", () => {
  it("nests a repository's transcript directory owner then name under the root", () => {
    expect(
      transcriptHostDir("/var/lib/border-collie/transcripts", "acme/widgets"),
    ).toBe("/var/lib/border-collie/transcripts/acme/widgets");
  });

  it("strips a trailing slash from the root before joining", () => {
    expect(transcriptHostDir("/root/", "acme/widgets")).toBe(
      "/root/acme/widgets",
    );
  });

  it("rejects a repository that is not a plain owner/repo pair", () => {
    expect(() => transcriptHostDir("/root", "widgets")).toThrow();
    expect(() => transcriptHostDir("/root", "acme/widgets/extra")).toThrow();
  });

  it("rejects a path-traversal segment", () => {
    expect(() => transcriptHostDir("/root", "../etc")).toThrow();
    expect(() => transcriptHostDir("/root", "acme/..")).toThrow();
    expect(() => transcriptHostDir("/root", "acme/../../etc")).toThrow();
  });
});

describe("ticketFromTranscriptFileName", () => {
  it("parses the Ticket from a session's stdout transcript file name", () => {
    expect(ticketFromTranscriptFileName("ticket-42-attempt-2.jsonl")).toBe(42);
  });

  it("parses the Ticket from a session's stderr file name", () => {
    expect(ticketFromTranscriptFileName("ticket-42-attempt-2.stderr.log")).toBe(
      42,
    );
  });

  it("parses nothing from a file this shape did not write", () => {
    expect(ticketFromTranscriptFileName("declare.jsonl")).toBeUndefined();
    expect(ticketFromTranscriptFileName("notes.txt")).toBeUndefined();
  });
});

describe("transcriptsToPrune", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const now = 30 * DAY;

  function file(name: string, ageMs: number): TranscriptFile {
    return { name, mtimeMs: now - ageMs };
  }

  it("prunes a file older than the retention window", () => {
    const files = [file("ticket-1-attempt-1.jsonl", 15 * DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([
      "ticket-1-attempt-1.jsonl",
    ]);
  });

  it("keeps a file within the retention window", () => {
    const files = [file("ticket-1-attempt-1.jsonl", DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([]);
  });

  it("never prunes a Ticket whose session container is still running, no matter its age", () => {
    const files = [file("ticket-1-attempt-1.jsonl", 30 * DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set([1]))).toEqual([]);
  });

  it("leaves a file it cannot parse as a session transcript alone, however old", () => {
    const files = [file("notes.txt", 30 * DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([]);
  });

  it("prunes only what is old, across a mixed directory listing", () => {
    const files = [
      file("ticket-1-attempt-1.jsonl", 20 * DAY),
      file("ticket-1-attempt-1.stderr.log", 20 * DAY),
      file("ticket-2-attempt-1.jsonl", HOUR),
    ];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([
      "ticket-1-attempt-1.jsonl",
      "ticket-1-attempt-1.stderr.log",
    ]);
  });
});
