import { test, expect, describe } from "bun:test";
import { renderTranscript } from "../../src/shared/openrouter.ts";
import { shiftSegments, type TranscriptSegment } from "../../src/shared/time.ts";

/**
 * Текст расшифровки собирается по кускам, а не из всех фраз сразу: куски
 * распознаются по отдельности, и в состоянии экземпляра Workflow они не
 * задерживаются — текст ложится в хранилище и читается оттуда.
 *
 * Отсюда свойство, на котором держится разбор: склеенный по кускам текст
 * обязан совпадать с текстом, собранным из всех фраз подряд. Разойдись они —
 * и модель увидела бы не тот эфир, а заметить это было бы нечем.
 */

function segment(start: number, text: string): TranscriptSegment {
  return { start, end: start + 3, text };
}

/** Так же, как в разборе: каждый кусок со своим смещением времени. */
function renderInChunks(chunks: ReadonlyArray<readonly TranscriptSegment[]>, offsets: readonly number[]): string {
  return chunks
    .map((chunk, index) => renderTranscript(shiftSegments(chunk, offsets[index] ?? 0)))
    .filter((part) => part !== "")
    .join("\n");
}

describe("сборка расшифровки", () => {
  test("текст по кускам совпадает с текстом целиком", () => {
    const first = [segment(0, "начало"), segment(3, "продолжение")];
    const second = [segment(10, "после стыка"), segment(13, "и дальше")];

    expect(renderInChunks([first, second], [0, 0])).toBe(renderTranscript([...first, ...second]));
  });

  test("смещения времени кусков дают те же метки, что и общий список", () => {
    // Куски нумеруются от нуля, поэтому метки приводятся ко времени эфира.
    const first = [segment(0, "кусок первый")];
    const second = [segment(0, "кусок второй")];

    expect(renderInChunks([first, second], [0, 600])).toBe(renderTranscript([...first, ...shiftSegments(second, 600)]));
  });

  test("пустые куски не добавляют пустых строк", () => {
    // Куски без речи — обычное дело: заставка, музыка, тишина.
    const speech = [segment(0, "речь")];

    expect(renderInChunks([[], speech, []], [0, 0, 0])).toBe(renderTranscript(speech));
  });
});
