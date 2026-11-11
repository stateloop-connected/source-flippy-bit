/**
 * Tests for the pure half of the game.
 *
 * Everything in `state.ts` and `util.ts` is a function from values to values,
 * so these run without a DOM. They are grouped the way the game is built up:
 * the small helpers first, then each stage of a time step, then the actions,
 * and finally the properties that have to hold across a whole run. The last
 * group is the one that catches real regressions, because it checks rules
 * that no single stage owns.
 */

import { assert, describe, expect, it } from "vitest";
import { firstValueFrom, of, take, toArray } from "rxjs";

import { state$ } from "../src/main";
import {
    Constants,
    Target,
    digitElementId,
    initialState,
} from "../src/types.ts";
import type { Bit, BitRow, FallingNumber, State } from "../src/types.ts";
import {
    Lehmer,
    nextSeed,
    pipeline,
    toHex,
    toRange,
    unitInterval,
} from "../src/util.ts";
import {
    FlipDigit,
    Restart,
    Tick,
    TogglePause,
    advanceClock,
    atCheckLine,
    atTopSpeed,
    bitsToValue,
    clearExit,
    despawn,
    fall,
    fallSpeed,
    flip,
    judge,
    lowestTarget,
    reduceState,
    releaseTarget,
    resolve,
    spawn,
    speedMultiplier,
    tick,
} from "../src/state.ts";
import {
    digitElementIds,
    digitKeyCodes,
    parseBest,
    startingSeed,
    tick$,
    toFlips,
} from "../src/observable.ts";

/** Builds a digit row from a string such as "00001111". */
const row = (pattern: string): BitRow =>
    [...pattern].map(character => (character === "1" ? 1 : 0) as Bit);

/** Builds a target for tests that do not care how it was spawned. */
const target = (id: string, value: number, y: number): FallingNumber => ({
    id,
    value,
    y,
});

/** A state built from the opening position with the given fields replaced. */
const given = (fields: Partial<State>): State => ({
    ...initialState,
    ...fields,
});

/** Applies `tick` `count` times. */
const ticks = (s: State, count: number): State =>
    Array.from({ length: count }).reduce<State>(current => tick(current), s);

/** Height at which a target's bottom edge has just reached the check line. */
const JUDGED_Y = Constants.CHECK_LINE_Y - Target.HEIGHT;

describe("state$", () => {
    it("is defined", () => {
        assert.isDefined(state$);
    });
    it("is a function", () => {
        assert.isFunction(state$);
    });
});

describe("util: pipeline", () => {
    it("applies its steps left to right", () => {
        const record: string[] = [];
        pipeline<number>(
            n => (record.push("first"), n + 1),
            n => (record.push("second"), n * 10),
        )(1);
        expect(record).toEqual(["first", "second"]);
    });

    it("produces the result of the last step", () => {
        // Left to right gives (1 + 1) * 10; right to left would give 11.
        expect(
            pipeline<number>(
                n => n + 1,
                n => n * 10,
            )(1),
        ).toBe(20);
    });

    it("is the identity when given no steps", () => {
        expect(pipeline<number>()(7)).toBe(7);
    });
});

describe("util: toHex", () => {
    it("pads to two digits so labels keep a constant width", () => {
        expect(toHex(0)).toBe("00");
        expect(toHex(15)).toBe("0F");
    });

    it("uses upper case for the letter digits", () => {
        expect(toHex(0xab)).toBe("AB");
    });

    it("covers the whole range a digit row can represent", () => {
        expect(toHex(255)).toBe("FF");
    });
});

describe("util: the pseudo-random generator", () => {
    it("keeps its product inside the exactly representable integers", () => {
        // Losing precision here would silently corrupt the sequence rather
        // than fail loudly, so it is worth asserting.
        expect(Lehmer.MODULUS * Lehmer.MULTIPLIER).toBeLessThan(
            Number.MAX_SAFE_INTEGER,
        );
    });

    it("returns the same seed for the same input", () => {
        expect(nextSeed(12345)).toBe(nextSeed(12345));
    });

    it("never leaves the range or reaches zero", () => {
        const walk = Array.from({ length: 10000 }).reduce<{
            seed: number;
            ok: boolean;
        }>(
            state => {
                const seed = nextSeed(state.seed);
                return {
                    seed,
                    ok: state.ok && seed > 0 && seed < Lehmer.MODULUS,
                };
            },
            { seed: 7, ok: true },
        );
        expect(walk.ok).toBe(true);
    });

    it("does not settle onto a single repeating value", () => {
        const seen = Array.from({ length: 500 }).reduce<number[]>(
            history => [...history, nextSeed(history[history.length - 1])],
            [1],
        );
        expect(new Set(seen).size).toBe(seen.length);
    });

    it("scales seeds into the unit interval", () => {
        expect(unitInterval(0)).toBe(0);
        expect(unitInterval(Lehmer.MODULUS)).toBe(1);
        expect(unitInterval(Lehmer.MODULUS / 2)).toBeCloseTo(0.5);
    });
});

describe("util: toRange", () => {
    it("reaches both ends of the range", () => {
        expect(toRange(0, 0, 255)).toBe(0);
        expect(toRange(0.9999999, 0, 255)).toBe(255);
    });

    it("never escapes the range for any fraction in the unit interval", () => {
        const samples = Array.from({ length: 1000 }, (_, i) => i / 1000);
        const values = samples.map(f => toRange(f, 63, 188));
        expect(Math.min(...values)).toBeGreaterThanOrEqual(63);
        expect(Math.max(...values)).toBeLessThanOrEqual(188);
    });

    it("spreads values across the range rather than clustering", () => {
        const values = Array.from({ length: 256 }, (_, i) =>
            toRange(i / 256, 0, 255),
        );
        expect(new Set(values).size).toBe(256);
    });
});

describe("digits", () => {
    it("flips a bit to its opposite", () => {
        expect(flip(0)).toBe(1);
        expect(flip(1)).toBe(0);
    });

    it("reads the row as a binary number, most significant bit first", () => {
        expect(bitsToValue(row("00000000"))).toBe(0);
        expect(bitsToValue(row("00001111"))).toBe(0x0f);
        expect(bitsToValue(row("00101010"))).toBe(0x2a);
        expect(bitsToValue(row("10000000"))).toBe(0x80);
        expect(bitsToValue(row("11111111"))).toBe(0xff);
    });

    it("covers exactly the values a target can take", () => {
        const every = Array.from({ length: 256 }, (_, value) =>
            bitsToValue(row(value.toString(2).padStart(8, "0"))),
        );
        expect(every).toEqual(Array.from({ length: 256 }, (_, i) => i));
    });
});

describe("choosing the target to judge", () => {
    it("finds nothing when the board is empty", () => {
        expect(lowestTarget([])).toBeUndefined();
    });

    it("picks the target furthest down the canvas", () => {
        const low = target("low", 1, 300);
        expect(
            lowestTarget([target("high", 2, 10), low, target("mid", 3, 90)]),
        ).toBe(low);
    });

    it("does not depend on the order targets were added", () => {
        const low = target("low", 1, 300);
        const others = [target("a", 2, 10), target("b", 3, 90)];
        expect(lowestTarget([low, ...others])).toBe(low);
        expect(lowestTarget([...others, low])).toBe(low);
    });

    it("judges a target once its bottom edge reaches the line", () => {
        expect(atCheckLine(target("t", 0, JUDGED_Y - 1))).toBe(false);
        expect(atCheckLine(target("t", 0, JUDGED_Y))).toBe(true);
    });
});

describe("the difficulty ramp", () => {
    it("starts at the base speed", () => {
        expect(fallSpeed(0)).toBe(Constants.FALL_SPEED);
    });

    it("never slows down as the player survives", () => {
        const speeds = Array.from({ length: 60 }, (_, i) => fallSpeed(i * 100));
        const rising = speeds.every(
            (speed, i) => i === 0 || speed >= speeds[i - 1],
        );
        expect(rising).toBe(true);
    });

    it("holds at a ceiling so the game stays winnable", () => {
        expect(fallSpeed(1e9)).toBe(Constants.MAX_FALL_SPEED);
    });
});

describe("the stages of a time step", () => {
    it("clears the previous step's departures", () => {
        const s = given({ exit: [target("gone", 1, 500)] });
        expect(clearExit(s).exit).toEqual([]);
    });

    it("counts the step that is being processed", () => {
        expect(advanceClock(given({ elapsed: 41 })).elapsed).toBe(42);
    });

    it("moves every target down by the current speed", () => {
        const s = given({
            targets: [target("a", 1, 0), target("b", 2, 100)],
            elapsed: 0,
        });
        expect(fall(s).targets.map(t => t.y)).toEqual([
            Constants.FALL_SPEED,
            100 + Constants.FALL_SPEED,
        ]);
    });

    it("retires targets that have left the canvas, into exit", () => {
        const gone = target("gone", 1, Constants.CHECK_LINE_Y + 1000);
        const kept = target("kept", 2, 10);
        const after = despawn(given({ targets: [gone, kept] }));
        expect(after.targets).toEqual([kept]);
        expect(after.exit).toEqual([gone]);
    });

    it("counts down before releasing the next target", () => {
        const waiting = spawn(given({ ticksUntilSpawn: 3 }));
        expect(waiting.ticksUntilSpawn).toBe(2);
        expect(waiting.targets).toEqual([]);
    });

    it("releases a target when the wait runs out", () => {
        const released = spawn(given({ ticksUntilSpawn: 0, seed: 12345 }));
        expect(released.targets).toHaveLength(1);
        expect(released.spawnCount).toBe(1);
    });
});

describe("releasing a target", () => {
    it("starts it above the canvas so it slides into view", () => {
        const released = releaseTarget(given({ seed: 12345 }));
        expect(released.targets[0].y).toBe(-Target.HEIGHT);
    });

    it("gives it a value a digit row can actually represent", () => {
        const values = Array.from({ length: 500 }).reduce<{
            s: State;
            seen: number[];
        }>(
            acc => {
                const next = releaseTarget(acc.s);
                return {
                    s: next,
                    seen: [
                        ...acc.seen,
                        next.targets[next.targets.length - 1].value,
                    ],
                };
            },
            { s: given({ seed: 2024 }), seen: [] },
        );
        expect(Math.min(...values.seen)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...values.seen)).toBeLessThanOrEqual(
            Constants.MAX_TARGET_VALUE,
        );
        // A generator stuck on a handful of values would still pass the bounds
        // check above, so insist on a real spread.
        expect(new Set(values.seen).size).toBeGreaterThan(100);
    });

    it("waits between one and three seconds before the next", () => {
        const waits = Array.from({ length: 500 }).reduce<{
            s: State;
            seen: number[];
        }>(
            acc => {
                const next = releaseTarget(acc.s);
                return { s: next, seen: [...acc.seen, next.ticksUntilSpawn] };
            },
            { s: given({ seed: 99 }), seen: [] },
        );
        expect(Math.min(...waits.seen)).toBeGreaterThanOrEqual(
            Constants.SPAWN_MIN_TICKS,
        );
        expect(Math.max(...waits.seen)).toBeLessThanOrEqual(
            Constants.SPAWN_MAX_TICKS,
        );
    });

    it("gives every target a distinct id for the renderer to match", () => {
        const ids = Array.from({ length: 50 }).reduce<{
            s: State;
            seen: string[];
        }>(
            acc => {
                const next = releaseTarget(acc.s);
                return {
                    s: next,
                    seen: [
                        ...acc.seen,
                        next.targets[next.targets.length - 1].id,
                    ],
                };
            },
            { s: given({ seed: 5 }), seen: [] },
        );
        expect(new Set(ids.seen).size).toBe(50);
    });
});

describe("judging the lowest target", () => {
    it("clears a target the moment the row matches, mid descent", () => {
        // The whole descent is the window, not the instant at the line.
        const midAir = target("t", 0x0f, 120);
        const after = judge(
            given({ targets: [midAir], bits: row("00001111") }),
        );
        expect(after.targets).toEqual([]);
        expect(after.exit).toEqual([midAir]);
        expect(after.score).toBe(1);
        expect(after.gameEnd).toBe(false);
    });

    it("ignores a target still above the top edge", () => {
        // Scoring one out of sight would award a point for something the
        // player never had a chance to read.
        const unseen = target("t", 0x0f, -Target.HEIGHT);
        const s = given({ targets: [unseen], bits: row("00001111") });
        expect(judge(s)).toBe(s);
    });

    it("waits while the row is wrong and the target still has room", () => {
        const midAir = target("t", 0x0f, 120);
        const s = given({ targets: [midAir], bits: row("00000000") });
        expect(judge(s)).toBe(s);
    });

    it("leaves everything alone until a target arrives", () => {
        const s = given({ targets: [target("high", 0xff, 10)] });
        expect(judge(s)).toBe(s);
    });

    it("retires a matched target and scores a point", () => {
        const arrived = target("t", 0x0f, JUDGED_Y);
        const after = judge(
            given({ targets: [arrived], bits: row("00001111") }),
        );
        expect(after.gameEnd).toBe(false);
        expect(after.score).toBe(1);
        expect(after.targets).toEqual([]);
        expect(after.exit).toEqual([arrived]);
    });

    it("ends the game on a mismatch", () => {
        const arrived = target("t", 0x0f, JUDGED_Y);
        const after = judge(
            given({ targets: [arrived], bits: row("00000000") }),
        );
        expect(after.gameEnd).toBe(true);
        expect(after.score).toBe(0);
    });

    it("leaves the missed target on screen so it can be read", () => {
        const arrived = target("t", 0x0f, JUDGED_Y);
        const after = judge(given({ targets: [arrived] }));
        expect(after.targets).toEqual([arrived]);
    });

    it("compares only the lowest target, ignoring those above it", () => {
        // The row matches the higher target. Judging must still fail, because
        // the lower one is the one at the line.
        const low = target("low", 0x0f, JUDGED_Y);
        const high = target("high", 0x2a, 20);
        const after = judge(
            given({ targets: [low, high], bits: row("00101010") }),
        );
        expect(after.gameEnd).toBe(true);
    });

    it("promotes the next target once the one below is resolved", () => {
        const low = target("low", 0x0f, JUDGED_Y);
        const high = target("high", 0x2a, 20);
        const resolved = judge(
            given({ targets: [low, high], bits: row("00001111") }),
        );
        expect(lowestTarget(resolved.targets)).toBe(high);
    });
});

describe("actions", () => {
    it("flips only the digit addressed", () => {
        const before = given({ bits: row("00000000") });
        const after = reduceState(before, new FlipDigit(3));
        expect(after.bits.join("")).toBe("00010000");
    });

    it("flips a digit back when addressed twice", () => {
        const once = reduceState(given({}), new FlipDigit(0));
        const twice = reduceState(once, new FlipDigit(0));
        expect(twice.bits.join("")).toBe("00000000");
    });

    it("ignores flips once the game is over", () => {
        const dead = given({ gameEnd: true, bits: row("00000000") });
        expect(reduceState(dead, new FlipDigit(0))).toBe(dead);
    });

    it("freezes the world once the game is over", () => {
        const dead = given({
            gameEnd: true,
            targets: [target("t", 1, 100)],
            elapsed: 500,
        });
        expect(reduceState(dead, new Tick())).toEqual(dead);
    });

    it("halts and resumes play", () => {
        const halted = reduceState(given({}), new TogglePause());
        expect(halted.paused).toBe(true);
        expect(reduceState(halted, new TogglePause()).paused).toBe(false);
    });

    it("freezes the world while paused", () => {
        const halted = given({
            paused: true,
            targets: [target("t", 1, 100)],
            elapsed: 500,
        });
        expect(reduceState(halted, new Tick())).toBe(halted);
        expect(ticks(halted, 200)).toBe(halted);
    });

    it("refuses to flip digits while paused", () => {
        // Otherwise pausing would buy unlimited thinking time on the target
        // currently in front of the player.
        const halted = given({ paused: true, bits: row("00000000") });
        expect(reduceState(halted, new FlipDigit(0))).toBe(halted);
    });

    it("does not pause a game that has already ended", () => {
        const dead = given({ gameEnd: true });
        expect(reduceState(dead, new TogglePause())).toBe(dead);
    });

    it("resumes on a restart from a paused game", () => {
        const halted = given({ paused: true, score: 5 });
        expect(reduceState(halted, new Restart()).paused).toBe(false);
    });

    it("returns to the opening position on a restart", () => {
        const played = given({
            score: 9,
            gameEnd: true,
            elapsed: 4000,
            spawnCount: 12,
            bits: row("10101010"),
        });
        const fresh = reduceState(played, new Restart());
        expect(fresh.score).toBe(0);
        expect(fresh.gameEnd).toBe(false);
        expect(fresh.elapsed).toBe(0);
        expect(fresh.spawnCount).toBe(0);
        expect(fresh.bits.join("")).toBe("00000000");
    });

    it("hands the targets in play to exit, so they get deleted", () => {
        // Resetting to the opening position alone would strand these on the
        // canvas: exit is the only channel the renderer has for removals.
        const inPlay = [target("a", 1, 50), target("b", 2, 200)];
        const fresh = reduceState(given({ targets: inPlay }), new Restart());
        expect(fresh.targets).toEqual([]);
        expect(fresh.exit).toEqual(inPlay);
    });

    it("carries the seed forward so a replay differs from the last run", () => {
        const played = ticks(given({ seed: 4242 }), 300);
        const fresh = reduceState(played, new Restart());
        expect(fresh.seed).toBe(played.seed);
        expect(fresh.seed).not.toBe(initialState.seed);
    });
});

describe("properties that must hold across a whole run", () => {
    /** A run long enough to spawn, judge and retire many targets. */
    const play = (seed: number, count: number): State[] =>
        Array.from({ length: count }).reduce<State[]>(
            history => [...history, tick(history[history.length - 1])],
            [given({ seed })],
        );

    it("never mutates the state it was given", () => {
        const start = given({ seed: 777 });
        const snapshot = JSON.stringify(start);
        ticks(start, 400);
        expect(JSON.stringify(start)).toBe(snapshot);
    });

    it("leaves the targets it was handed alone when they fall", () => {
        // Writing `y` straight into each target would look identical on
        // screen while quietly destroying every earlier state.
        const before = target("a", 1, 100);
        const s = given({ targets: [before] });
        fall(s);
        expect(before.y).toBe(100);
        expect(s.targets[0]).toBe(before);
    });

    it("never writes back into a frame it has already produced", () => {
        // The check above only covers one stage. This takes a copy of every
        // frame as it appears and re-reads them all at the end, so any stage
        // that reaches back into an earlier state is caught wherever it is.
        const record = Array.from({ length: 400 }).reduce<{
            s: State;
            frames: { live: State; copy: string }[];
        }>(
            acc => {
                const s = tick(acc.s);
                return {
                    s,
                    frames: [
                        ...acc.frames,
                        { live: s, copy: JSON.stringify(s) },
                    ],
                };
            },
            { s: given({ seed: 4321 }), frames: [] },
        );
        const rewritten = record.frames.filter(
            frame => JSON.stringify(frame.live) !== frame.copy,
        );
        expect(rewritten).toEqual([]);
    });

    it("never mutates the shared opening position", () => {
        const snapshot = JSON.stringify(initialState);
        ticks(given({ seed: 31 }), 400);
        reduceState(given({ targets: [target("a", 1, 5)] }), new Restart());
        expect(JSON.stringify(initialState)).toBe(snapshot);
    });

    it("keeps the digit row exactly eight digits long", () => {
        const flipped = Array.from({ length: 8 }).reduce<State>(
            (s, _, index) => reduceState(s, new FlipDigit(index)),
            given({}),
        );
        expect(flipped.bits).toHaveLength(Constants.DIGIT_COUNT);
        expect(ticks(flipped, 300).bits).toHaveLength(Constants.DIGIT_COUNT);
    });

    it("only ever loses at the line, never with a matching row", () => {
        // Since a match clears the target wherever it is, a target that
        // reaches the line must have gone unmatched the whole way down.
        const history = play(2468, 800);
        const lost = history.filter(s => s.gameEnd);
        const wrongly = lost.filter(s => {
            const low = lowestTarget(s.targets);
            return low !== undefined && bitsToValue(s.bits) === low.value;
        });
        expect(wrongly).toEqual([]);
    });

    it("never lets the score go down", () => {
        const scores = play(1234, 600).map(s => s.score);
        expect(scores.every((n, i) => i === 0 || n >= scores[i - 1])).toBe(
            true,
        );
    });

    it("accounts for every target that leaves the board", () => {
        // Anything dropped without passing through exit would leave an SVG
        // element behind forever, which is the leak this rule prevents.
        const history = play(88, 600);
        const stranded = history.slice(1).filter((s, i) => {
            const before = history[i];
            const departed = before.targets.filter(
                t => !s.targets.some(kept => kept.id === t.id),
            );
            return departed.some(t => !s.exit.some(left => left.id === t.id));
        });
        expect(stranded).toEqual([]);
    });

    it("holds the seed inside the generator's range throughout", () => {
        const seeds = play(3, 600).map(s => s.seed);
        expect(seeds.every(seed => seed > 0 && seed < Lehmer.MODULUS)).toBe(
            true,
        );
    });

    it("stops the board growing without bound", () => {
        // Targets spawn on a timer, so an unbounded board would mean the
        // despawn and judge stages had stopped retiring them.
        const boards = play(555, 900).map(s => s.targets.length);
        expect(Math.max(...boards)).toBeLessThan(10);
    });

    it("plays out differently from different opening seeds", () => {
        const values = (seed: number) =>
            play(seed, 400)
                .flatMap(s => s.targets.map(t => t.value))
                .join(",");
        expect(values(11)).not.toBe(values(22));
    });

    it("replays identically from the same opening seed", () => {
        const values = (seed: number) =>
            play(seed, 400)
                .flatMap(s => s.targets.map(t => t.value))
                .join(",");
        expect(values(11)).toBe(values(11));
    });
});

describe("the event streams", () => {
    /** Collects everything a finite stream emits. */
    const collect = <T>(source: Parameters<typeof firstValueFrom<T[]>>[0]) =>
        firstValueFrom(source);

    it("turns each addressed position into a flip for that digit", async () => {
        const actions = await collect(toFlips(of(0, 3, 7)).pipe(toArray()));
        expect(actions).toHaveLength(3);
        expect(actions.map(a => (a as FlipDigit).index)).toEqual([0, 3, 7]);
    });

    it("drops positions that addressed no digit", async () => {
        const actions = await collect(
            toFlips(of(-1, 2, -1, 5)).pipe(toArray()),
        );
        expect(actions.map(a => (a as FlipDigit).index)).toEqual([2, 5]);
    });

    it("keeps the leftmost digit, which sits at position zero", async () => {
        // A `> 0` test in place of `>= 0` would silently ignore digit one.
        const actions = await collect(toFlips(of(0)).pipe(toArray()));
        expect(actions).toHaveLength(1);
        expect((actions[0] as FlipDigit).index).toBe(0);
    });

    it("emits nothing when every position was a miss", async () => {
        const actions = await collect(toFlips(of(-1, -1, -1)).pipe(toArray()));
        expect(actions).toEqual([]);
    });

    it("names one key and one element per digit, left to right", () => {
        expect(digitKeyCodes).toEqual([
            "Digit1",
            "Digit2",
            "Digit3",
            "Digit4",
            "Digit5",
            "Digit6",
            "Digit7",
            "Digit8",
        ]);
        expect(digitElementIds).toHaveLength(Constants.DIGIT_COUNT);
        expect(digitElementIds).toEqual(
            Array.from({ length: Constants.DIGIT_COUNT }, (_, i) =>
                digitElementId(i),
            ),
        );
    });

    it("looks every digit back up from its key and its element id", () => {
        // Both streams turn an identifier into a position with `indexOf`, so
        // the tables have to round-trip for all eight digits.
        const positions = Array.from(
            { length: Constants.DIGIT_COUNT },
            (_, i) => i,
        );
        expect(
            positions.map(i => digitKeyCodes.indexOf(digitKeyCodes[i])),
        ).toEqual(positions);
        expect(
            positions.map(i => digitElementIds.indexOf(digitElementIds[i])),
        ).toEqual(positions);
    });

    it("rejects identifiers that belong to no digit", () => {
        ["Digit9", "Digit0", "KeyA", "Space", ""].forEach(code =>
            expect(digitKeyCodes.indexOf(code)).toBe(-1),
        );
        expect(digitElementIds.indexOf("digit-8")).toBe(-1);
    });

    it("opens on a seed the generator can actually use", () => {
        const seeds = Array.from({ length: 20 }, () => startingSeed());
        expect(seeds.every(seed => seed > 0 && seed < Lehmer.MODULUS)).toBe(
            true,
        );
    });

    it("beats time with Tick actions", async () => {
        const actions = await collect(tick$().pipe(take(3), toArray()));
        expect(actions).toHaveLength(3);
        expect(actions.every(a => a instanceof Tick)).toBe(true);
    });
});

describe("best score", () => {
    it("rises with the score once the score passes it", () => {
        const s = resolve(given({ score: 4, best: 4 }), target("t", 1, 100));
        expect(s.score).toBe(5);
        expect(s.best).toBe(5);
    });

    it("stays put while the score is still below it", () => {
        const s = resolve(given({ score: 2, best: 9 }), target("t", 1, 100));
        expect(s.best).toBe(9);
    });

    it("survives a restart while the score resets", () => {
        const fresh = reduceState(given({ score: 7, best: 12 }), new Restart());
        expect(fresh.score).toBe(0);
        expect(fresh.best).toBe(12);
    });

    it("never decreases over a whole run", () => {
        const history = Array.from({ length: 3000 }).reduce<State[]>(
            states => [...states, tick(states[states.length - 1])],
            [given({ seed: 99, best: 3 })],
        );
        history.slice(1).forEach((s, i) => {
            expect(s.best).toBeGreaterThanOrEqual(history[i].best);
        });
    });
});

describe("stored best score", () => {
    it("reads a stored whole number", () => {
        expect(parseBest("12")).toBe(12);
    });

    it("falls back to 0 when nothing was stored", () => {
        expect(parseBest(null)).toBe(0);
    });

    it("rejects text, fractions and negative numbers", () => {
        expect(parseBest("abc")).toBe(0);
        expect(parseBest("3.5")).toBe(0);
        expect(parseBest("-4")).toBe(0);
    });
});

describe("speed readout", () => {
    it("starts at the opening pace", () => {
        expect(speedMultiplier(0)).toBe(1);
        expect(atTopSpeed(0)).toBe(false);
    });

    it("climbs with time and stops at the ceiling", () => {
        const late = Constants.SPEEDUP_INTERVAL_TICKS * 10;
        expect(speedMultiplier(Constants.SPEEDUP_INTERVAL_TICKS)).toBe(2);
        expect(speedMultiplier(late)).toBe(
            Constants.MAX_FALL_SPEED / Constants.FALL_SPEED,
        );
        expect(atTopSpeed(late)).toBe(true);
    });
});
