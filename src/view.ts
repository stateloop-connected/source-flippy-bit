/**
 * Rendering (side effects).
 *
 * This is the only module allowed to mutate anything. Every function below
 * either creates or updates an SVG element, and `render` is the single point
 * where the pure state produced by `state.ts` is turned into pixels.
 */

import {
    Constants,
    Target,
    Viewport,
    digitElementId,
    initialState,
} from "./types.ts";
import type { Bit, FallingNumber, State } from "./types.ts";
import { toHex } from "./util.ts";
import {
    atTopSpeed,
    bitsToValue,
    lowestTarget,
    speedMultiplier,
} from "./state.ts";
import { BEST_SCORE_KEY, startingBest } from "./observable.ts";

/** Fill colours distinguishing a digit that is off from one that is on. */
const DigitColour = {
    OFF: "#1d2b3f",
    ON: "#3d8fd1",
} as const;

/** Geometry of the row of digit toggles along the bottom of the canvas. */
const Digit = {
    WIDTH: Viewport.CANVAS_WIDTH / Constants.DIGIT_COUNT,
    HEIGHT: 40,
    PADDING: 4,
    TOP: Viewport.CANVAS_HEIGHT - 50,
    BASELINE: Viewport.CANVAS_HEIGHT - 22,
} as const;

/** Where a falling target sits horizontally, and where its label sits in it. */
const TargetLayout = {
    LEFT: Viewport.CANVAS_WIDTH / 2 - Target.WIDTH / 2,
    CENTRE: Viewport.CANVAS_WIDTH / 2,
    /** Label baseline, measured down from the top of the box. */
    BASELINE: Target.HEIGHT / 2 + 8,
} as const;

/**
 * Placement of the readout showing what the digit row currently spells.
 *
 * It sits at the right end of the check line, clear of the column the targets
 * fall down, and close to both the row and the target being solved.
 */
const RowReadout = {
    X: Viewport.CANVAS_WIDTH - 8,
    Y: Constants.CHECK_LINE_Y - 10,
} as const;

/**
 * Outline widths separating the target being judged from the rest.
 *
 * Only the lowest target counts, and nothing on screen said so; the heavier
 * outline states the rule instead of leaving the player to infer it.
 */
const TargetOutline = {
    LIVE: "4",
    WAITING: "2",
} as const;

/**
 * The panel shown while play is halted.
 *
 * It borrows the position and proportions of the game over panel, so
 * the two overlays read as the same kind of thing. They are never on screen
 * together, because a finished game cannot be paused.
 */
const PausePanel = {
    TEXT: "Paused",
    HINT: "press P to resume",
    LEFT: Viewport.CANVAS_WIDTH / 2 - 110,
    TOP: 160,
    WIDTH: 220,
    HEIGHT: 92,
    CAPTION_BASELINE: 200,
    HINT_BASELINE: 232,
} as const;

/** Wording and placement of the prompt shown with the game over panel. */
const RestartHint = {
    TEXT: "press R to restart",
    X: Viewport.CANVAS_WIDTH / 2,
    Y: 232,
} as const;

/**
 * A box with a label centred in it.
 *
 * Digits and targets are drawn the same way, so they share both this type and
 * the functions that position and delete it.
 */
type LabelledBox = Readonly<{
    box: SVGElement;
    label: SVGElement;
}>;

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

/** Removes a box and its label from the canvas, if they are still there. */
const removeBox = (elements: LabelledBox | undefined): void => {
    elements?.box.remove();
    elements?.label.remove();
};

/**
 * Adds the restart prompt to the game over group.
 *
 * Placing it inside that group lets the show and hide helpers carry it along
 * with the caption, so the two always appear together.
 *
 * @param svg Canvas the group belongs to
 * @param gameOver Group holding the game over caption
 */
const addRestartHint = (svg: SVGSVGElement, gameOver: SVGElement): void => {
    const hint = createSvgElement(svg.namespaceURI, "text", {
        x: `${RestartHint.X}`,
        y: `${RestartHint.Y}`,
        "text-anchor": "middle",
        "font-family": "monospace",
        "font-size": "14",
        fill: "#9fb6cc",
    });
    hint.textContent = RestartHint.TEXT;
    gameOver.appendChild(hint);
};

/**
 * Adds the readout of the digit row's current value.
 *
 * The row already shows the answer the player is building, but in binary; a
 * target states its value in hexadecimal. Restating the row the same way lets
 * the two be compared by eye rather than converted in the player's head.
 *
 * @param svg Canvas to draw into
 * @returns The element, for later updates
 */
const addRowReadout = (svg: SVGSVGElement): SVGElement => {
    const readout = createSvgElement(svg.namespaceURI, "text", {
        x: `${RowReadout.X}`,
        y: `${RowReadout.Y}`,
        "text-anchor": "end",
        "font-family": "monospace",
        "font-size": "17",
        "font-weight": "bold",
        fill: "#9fb6cc",
    });
    svg.appendChild(readout);
    return readout;
};

/**
 * Builds the panel shown while play is halted, hidden until it is needed.
 *
 * @param svg Canvas to draw into
 * @returns The group, for the show and hide helpers to work on
 */
const addPausePanel = (svg: SVGSVGElement): SVGElement => {
    const group = createSvgElement(svg.namespaceURI, "g", {
        visibility: "hidden",
    });
    const panel = createSvgElement(svg.namespaceURI, "rect", {
        x: `${PausePanel.LEFT}`,
        y: `${PausePanel.TOP}`,
        width: `${PausePanel.WIDTH}`,
        height: `${PausePanel.HEIGHT}`,
        rx: "10",
        fill: "#16263b",
    });
    const caption = createSvgElement(svg.namespaceURI, "text", {
        x: `${Viewport.CANVAS_WIDTH / 2}`,
        y: `${PausePanel.CAPTION_BASELINE}`,
        "text-anchor": "middle",
        "font-size": "24",
        "font-weight": "bold",
        fill: "#ffffff",
    });
    caption.textContent = PausePanel.TEXT;
    const hint = createSvgElement(svg.namespaceURI, "text", {
        x: `${Viewport.CANVAS_WIDTH / 2}`,
        y: `${PausePanel.HINT_BASELINE}`,
        "text-anchor": "middle",
        "font-family": "monospace",
        "font-size": "14",
        fill: "#9fb6cc",
    });
    hint.textContent = PausePanel.HINT;
    group.appendChild(panel);
    group.appendChild(caption);
    group.appendChild(hint);
    svg.appendChild(group);
    return group;
};

/** Draws the height a target must be matched by. */
const addCheckLine = (svg: SVGSVGElement): void => {
    svg.appendChild(
        createSvgElement(svg.namespaceURI, "line", {
            x1: "0",
            y1: `${Constants.CHECK_LINE_Y}`,
            x2: `${Viewport.CANVAS_WIDTH}`,
            y2: `${Constants.CHECK_LINE_Y}`,
            stroke: "#e2a23b",
            "stroke-width": "2",
            "stroke-dasharray": "8 6",
        }),
    );
};

/**
 * Adds the two SVG elements for the digit at position `index` to the canvas.
 *
 * Only attributes that never change are set here; everything that varies with
 * the state is left to `updateDigit`.
 *
 * @param svg Canvas to draw into
 * @param index Position of the digit in the row, counting from the left
 * @returns The created elements, for later updates
 */
const addDigit = (svg: SVGSVGElement, index: number): LabelledBox => {
    const left = index * Digit.WIDTH;
    const box = createSvgElement(svg.namespaceURI, "rect", {
        id: digitElementId(index),
        x: `${left + Digit.PADDING}`,
        y: `${Digit.TOP}`,
        width: `${Digit.WIDTH - Digit.PADDING * 2}`,
        height: `${Digit.HEIGHT}`,
        rx: "6",
        stroke: "#2b3e57",
        "stroke-width": "2",
    });
    const label = createSvgElement(svg.namespaceURI, "text", {
        x: `${left + Digit.WIDTH / 2}`,
        y: `${Digit.BASELINE}`,
        "text-anchor": "middle",
        "font-family": "monospace",
        "font-weight": "bold",
        fill: "#eef3f8",
        // Let clicks fall through to the box behind, so hitting the numeral
        // counts as hitting the digit.
        "pointer-events": "none",
    });
    svg.appendChild(box);
    svg.appendChild(label);
    return { box, label };
};

/**
 * Points one digit's elements at the value it currently holds.
 *
 * @param elements Elements created for this digit by `addDigit`
 * @param bit Value the digit should display
 */
const updateDigit = (elements: LabelledBox, bit: Bit): void => {
    const colour = bit === 1 ? DigitColour.ON : DigitColour.OFF;
    elements.box.setAttribute("fill", colour);
    elements.label.textContent = `${bit}`;
};

/**
 * Adds the elements for a target on the frame it first appears.
 *
 * The value never changes once a target exists, so the label text is written
 * here and only the vertical position is touched afterwards.
 *
 * @param svg Canvas to draw into
 * @param target Target that has just spawned
 * @returns The created elements, for later updates
 */
const addTarget = (svg: SVGSVGElement, target: FallingNumber): LabelledBox => {
    const box = createSvgElement(svg.namespaceURI, "rect", {
        x: `${TargetLayout.LEFT}`,
        width: `${Target.WIDTH}`,
        height: `${Target.HEIGHT}`,
        rx: "8",
        fill: "#f3f7fb",
        stroke: "#7cc0f5",
        "stroke-width": "2",
    });
    const label = createSvgElement(svg.namespaceURI, "text", {
        x: `${TargetLayout.CENTRE}`,
        "text-anchor": "middle",
        "font-family": "monospace",
        fill: "black",
    });
    label.textContent = toHex(target.value);
    svg.appendChild(box);
    svg.appendChild(label);
    return { box, label };
};

/**
 * Moves a target's elements to the height it has fallen to.
 *
 * @param elements Elements created for this target by `addTarget`
 * @param target Target holding the current height
 */
const moveTarget = (elements: LabelledBox, target: FallingNumber): void => {
    elements.box.setAttribute("y", `${target.y}`);
    elements.label.setAttribute("y", `${target.y + TargetLayout.BASELINE}`);
};

/**
 * Stores the best score so it survives a page reload.
 *
 * Storage can be unavailable (private browsing, blocked cookies); the game is
 * still fully playable without it, so a failure is ignored.
 *
 * @param best Score to store
 */
const saveBest = (best: number): void => {
    try {
        localStorage.setItem(BEST_SCORE_KEY, `${best}`);
    } catch {
        // Nothing to do: the best score simply will not persist.
    }
};

/** Removes the opening screen once the player has started. */
const hideStartScreen = (): void => {
    document.querySelector("#startScreen")?.classList.add("hidden");
};

const render = (): ((s: State) => void) => {
    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;
    const bestText = document.querySelector("#bestText") as HTMLElement;
    const speedText = document.querySelector("#speedText") as HTMLElement;
    // The stored value is what is on disk already, so only a change is written.
    let savedBest = startingBest();

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    addCheckLine(svg);
    addRestartHint(svg, gameOver);
    const rowReadout = addRowReadout(svg);
    const pausePanel = addPausePanel(svg);

    // Built once and captured by the closure below. Updating these elements
    // each frame, rather than appending a fresh row, is what keeps the node
    // count constant however long the game runs.
    const digits = Array.from({ length: Constants.DIGIT_COUNT }, (_, index) =>
        addDigit(svg, index),
    );

    // Targets come and go, so unlike the fixed digit row their elements are
    // looked up by id as the state reports them.
    const targets = new Map<string, LabelledBox>();

    /** Draws a target, building its elements the first time it is seen. */
    const drawTarget = (target: FallingNumber, live: boolean): void => {
        const elements = targets.get(target.id) ?? addTarget(svg, target);
        targets.set(target.id, elements);
        moveTarget(elements, target);
        elements.box.setAttribute(
            "stroke-width",
            live ? TargetOutline.LIVE : TargetOutline.WAITING,
        );
    };

    /** Deletes the elements of a target that has left play. */
    const clearTarget = (target: FallingNumber): void => {
        removeBox(targets.get(target.id));
        targets.delete(target.id);
    };

    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    const paint = (s: State): void => {
        const live = lowestTarget(s.targets);
        s.bits.forEach((bit, index) => updateDigit(digits[index], bit));
        s.targets.forEach(target => drawTarget(target, target === live));
        s.exit.forEach(clearTarget);
        rowReadout.textContent = `row ${toHex(bitsToValue(s.bits))}`;
        scoreText.textContent = `${s.score}`;
        bestText.textContent = `${s.best}`;
        speedText.textContent = atTopSpeed(s.elapsed)
            ? "max"
            : `×${speedMultiplier(s.elapsed).toFixed(1)}`;
        if (s.best !== savedBest) {
            saveBest(s.best);
            savedBest = s.best;
        }
        s.gameEnd ? show(gameOver) : hide(gameOver);
        s.paused ? show(pausePanel) : hide(pausePanel);
    };

    // Paint the starting position now rather than waiting for the first tick,
    // which would otherwise leave the digits showing an SVG default fill. The
    // stored best score is shown straight away, before the first game.
    paint({ ...initialState, best: savedBest });

    return paint;
};

export {
    bringToForeground,
    show,
    hide,
    createSvgElement,
    hideStartScreen,
    render,
};
