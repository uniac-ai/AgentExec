/** About this many characters make a token, as Codex counts them. */
export const CHARS_PER_TOKEN = 4;

/** What one session holds between polls: its first and last half of this many characters. */
const HELD = 1024 * 1024;

/** `text`, or its first and last halves of `max` characters, saying how much was cut between. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.max(1, Math.floor(max / 2));
  // Never half a surrogate pair at either edge.
  const head = text.slice(0, half).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-half).replace(/^[\uDC00-\uDFFF]/, "");
  return `${head}\n… ${text.length - head.length - tail.length} characters cut …\n${tail}`;
}

/** Output not yet read: everything, or its head and tail when a command writes without a pause. */
export class Pending {
  #head = "";
  #tail = "";
  #dropped = 0;

  add(text: string) {
    const room = HELD / 2 - this.#head.length;
    if (room > 0) {
      this.#head += text.slice(0, room);
      text = text.slice(room);
    }
    this.#tail += text;
    const over = this.#tail.length - HELD / 2;
    if (over > 0) {
      this.#tail = this.#tail.slice(over);
      this.#dropped += over;
    }
  }

  /** What is pending, leaving nothing. */
  take(): string {
    const text = this.#dropped
      ? `${this.#head}\n… ${this.#dropped} characters cut …\n${this.#tail}`
      : this.#head + this.#tail;
    this.#head = "";
    this.#tail = "";
    this.#dropped = 0;
    return text;
  }
}
