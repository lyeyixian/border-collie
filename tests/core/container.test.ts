import { describe, expect, it } from "vitest";
import {
  ATTEMPT_LABEL,
  encodeSessionLabels,
  parseSessionLabels,
  REPOSITORY_LABEL,
  type SessionLabels,
  TICKET_LABEL,
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
