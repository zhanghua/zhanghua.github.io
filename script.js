// === State ===
let image1Data = null;
let image2Data = null;
let lastChars1 = [];
let lastChars2 = [];
let lastLines1 = [];
let lastLines2 = [];
let lastPairs = []; // {orig, practice, score} for char mode
let lastLinePairs = []; // {orig, practice} for line mode
let currentZoom = 1;

// === DOM references ===
const image1Input = document.getElementById('image1Input');
const image2Input = document.getElementById('image2Input');
const canvas1 = document.getElementById('canvas1');
const canvas2 = document.getElementById('canvas2');
const direction1Select = document.getElementById('direction1');
const direction2Select = document.getElementById('direction2');
const lineCount1Input = document.getElementById('lineCount1');
const lineCount2Input = document.getElementById('lineCount2');
const charsPerLine1Input = document.getElementById('charsPerLine1');
const charsPerLine2Input = document.getElementById('charsPerLine2');
const segmentBtn = document.getElementById('segmentBtn');
const downloadBtn = document.getElementById('downloadBtn');
const clearBtn = document.getElementById('clearBtn');
const matchModeSelect = document.getElementById('matchMode');
const compareModeSelect = document.getElementById('compareMode');
const resultsSection = document.getElementById('resultsSection');
const resultsTitle = document.getElementById('resultsTitle');
const comparisonGrid = document.getElementById('comparisonGrid');
const matchModeGroup = document.getElementById('matchModeGroup');

// === Event listeners ===
image1Input.addEventListener('change', (e) => handleImageUpload(e, 1));
image2Input.addEventListener('change', (e) => handleImageUpload(e, 2));
segmentBtn.addEventListener('click', segmentAndCompare);
downloadBtn.addEventListener('click', downloadComparison);
clearBtn.addEventListener('click', clearAll);
compareModeSelect.addEventListener('change', () => {
    matchModeGroup.style.display = compareModeSelect.value === 'char' ? '' : 'none';
});
resultsSection.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(currentZoom + delta);
}, { passive: false });
setZoom(1);

// === Image handling ===
function handleImageUpload(event, imageNumber) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            if (imageNumber === 1) {
                image1Data = img;
                displayImageOnCanvas(img, canvas1);
            } else {
                image2Data = img;
                displayImageOnCanvas(img, canvas2);
            }
            checkEnableSegmentButton();
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function displayImageOnCanvas(img, canvas) {
    const ctx = canvas.getContext('2d');
    const maxWidth = 500;
    const maxHeight = 400;
    let width = img.width;
    let height = img.height;
    if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width *= ratio;
        height *= ratio;
    }
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);
    canvas.classList.add('active');
}

// === Zoom ===
function setZoom(val) {
    currentZoom = Math.min(4, Math.max(0.3, val));
    updateZoomLayouts();
}

function updateZoomLayouts() {
    document.querySelectorAll('.canvas-wrap').forEach(el => {
        const w = parseFloat(el.dataset.w || '0');
        const h = parseFloat(el.dataset.h || '0');
        const s = parseFloat(el.dataset.scale || '1');
        el.style.width = `${w * s * currentZoom}px`;
        el.style.height = `${h * s * currentZoom}px`;
        const cvs = el.querySelector('canvas');
        if (cvs) cvs.style.transform = `scale(${s * currentZoom})`;
    });
}

function checkEnableSegmentButton() {
    segmentBtn.disabled = !(image1Data && image2Data);
}

// ============================================================
// Core segmentation: 2D projection-based character extraction
// ============================================================

function getAdaptiveThreshold(pixelData, width, height) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < pixelData.length; i += 4) {
        const b = Math.round((pixelData[i] + pixelData[i + 1] + pixelData[i + 2]) / 3);
        hist[b]++;
    }

    let bgMode = 0;
    for (let i = 1; i < 256; i++) {
        if (hist[i] > hist[bgMode]) bgMode = i;
    }

    const totalPixels = pixelData.length / 4;
    let cum = 0, darkSum = 0, darkCount = 0;
    for (let i = 0; i < 256; i++) {
        const take = Math.min(hist[i], Math.max(0, totalPixels * 0.1 - cum));
        darkSum += i * take;
        darkCount += take;
        cum += hist[i];
    }
    cum = 0;
    let brightSum = 0, brightCount = 0;
    for (let i = 255; i >= 0; i--) {
        const take = Math.min(hist[i], Math.max(0, totalPixels * 0.1 - cum));
        brightSum += i * take;
        brightCount += take;
        cum += hist[i];
    }

    const darkAvg = darkCount ? darkSum / darkCount : 0;
    const brightAvg = brightCount ? brightSum / brightCount : 255;
    const textIsDark = darkAvg + 20 < brightAvg;

    let thresholdVal = textIsDark ? bgMode - 30 : bgMode + 30;
    thresholdVal = Math.min(230, Math.max(25, thresholdVal));

    const isInk = (brightness) => textIsDark ? brightness < thresholdVal : brightness > thresholdVal;
    return { thresholdVal, textIsDark, isInk, bgMode };
}

function computeProjection(pixelData, width, height, axis, isInk) {
    const size = axis === 'x' ? width : height;
    const density = new Array(size).fill(0);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const brightness = (pixelData[i] + pixelData[i + 1] + pixelData[i + 2]) / 3;
            if (isInk(brightness)) {
                density[axis === 'x' ? x : y]++;
            }
        }
    }
    return density;
}

function smoothProjection(density, windowSize) {
    return density.map((_, idx) => {
        let sum = 0, count = 0;
        for (let k = -windowSize; k <= windowSize; k++) {
            const i = idx + k;
            if (i >= 0 && i < density.length) {
                sum += density[i];
                count++;
            }
        }
        return sum / count;
    });
}

function findSegmentsFromProjection(smoothed, totalLength, valleyRatio) {
    const maxVal = Math.max(...smoothed);
    if (maxVal === 0) return [{ start: 0, end: totalLength }];

    const threshold = maxVal * (valleyRatio || 0.15);
    const minGap = Math.max(2, Math.floor(totalLength * 0.008));

    const cuts = [];
    let inGap = false, gapStart = 0;
    for (let i = 0; i < smoothed.length; i++) {
        if (smoothed[i] < threshold) {
            if (!inGap) { inGap = true; gapStart = i; }
        } else if (inGap) {
            if (i - gapStart >= minGap) {
                cuts.push(Math.round((gapStart + i) / 2));
            }
            inGap = false;
        }
    }
    if (inGap && smoothed.length - gapStart >= minGap) {
        cuts.push(Math.round((gapStart + smoothed.length) / 2));
    }

    const segments = [];
    const allCuts = [0, ...cuts, totalLength];
    for (let i = 0; i < allCuts.length - 1; i++) {
        const start = allCuts[i];
        const end = allCuts[i + 1];
        if (end - start > totalLength * 0.02) {
            segments.push({ start, end });
        }
    }

    return segments.length > 0 ? segments : [{ start: 0, end: totalLength }];
}

/**
 * Enhanced primary-axis segmentation using local-minima valley detection.
 * Finds prominent valleys as cut points even when absolute density doesn't
 * drop below a fixed threshold (e.g. ruled paper, tight column spacing).
 */
function findPrimarySegments(smoothed, totalLength) {
    const maxVal = Math.max(...smoothed);
    if (maxVal === 0) return [{ start: 0, end: totalLength }];

    // Step 1: find all local minima
    const minima = [];
    for (let i = 2; i < smoothed.length - 2; i++) {
        if (smoothed[i] <= smoothed[i - 1] && smoothed[i] <= smoothed[i + 1] &&
            smoothed[i] <= smoothed[i - 2] && smoothed[i] <= smoothed[i + 2]) {
            minima.push(i);
        }
    }

    if (minima.length === 0) return [{ start: 0, end: totalLength }];

    // Step 2: score each minimum by the depth relative to its neighbors' peaks
    const scoredMinima = minima.map(pos => {
        // Find peak to the left
        let leftPeak = smoothed[pos];
        for (let j = pos - 1; j >= Math.max(0, pos - Math.floor(totalLength * 0.15)); j--) {
            if (smoothed[j] > leftPeak) leftPeak = smoothed[j];
        }
        // Find peak to the right
        let rightPeak = smoothed[pos];
        for (let j = pos + 1; j <= Math.min(smoothed.length - 1, pos + Math.floor(totalLength * 0.15)); j++) {
            if (smoothed[j] > rightPeak) rightPeak = smoothed[j];
        }
        // Prominence: how much does this valley dip below the lower of its two flanking peaks
        const flanking = Math.min(leftPeak, rightPeak);
        const prominence = flanking > 0 ? (flanking - smoothed[pos]) / flanking : 0;
        return { pos, val: smoothed[pos], prominence };
    });

    // Step 3: keep valleys with meaningful prominence
    // A prominence of 0.15 means the valley is at least 15% below the lower neighboring peak
    const minProminence = 0.15;
    const minDistance = Math.floor(totalLength * 0.04);

    const goodCuts = scoredMinima
        .filter(m => m.prominence >= minProminence)
        .sort((a, b) => b.prominence - a.prominence);

    // Greedy selection: pick most prominent first, skip if too close to an already-picked cut
    const selected = [];
    for (const cut of goodCuts) {
        if (selected.every(s => Math.abs(s - cut.pos) >= minDistance)) {
            selected.push(cut.pos);
        }
    }
    selected.sort((a, b) => a - b);

    if (selected.length === 0) return [{ start: 0, end: totalLength }];

    // Build segments
    const segments = [];
    const allCuts = [0, ...selected, totalLength];
    for (let i = 0; i < allCuts.length - 1; i++) {
        const start = allCuts[i];
        const end = allCuts[i + 1];
        if (end - start > totalLength * 0.02) {
            segments.push({ start, end });
        }
    }
    return segments.length > 0 ? segments : [{ start: 0, end: totalLength }];
}

/**
 * Merge segments that are too small (likely character fragments) into their
 * nearest neighbor. minSize = minimum expected character dimension.
 */
function mergeSmallSegments(segments, minSize) {
    if (segments.length <= 1) return segments;
    const result = [...segments];

    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i < result.length; i++) {
            const size = result[i].end - result[i].start;
            if (size < minSize && result.length > 1) {
                // Merge with whichever neighbor has the smaller gap
                const gapLeft = i > 0 ? result[i].start - result[i - 1].end : Infinity;
                const gapRight = i < result.length - 1 ? result[i + 1].start - result[i].end : Infinity;
                if (gapLeft <= gapRight && i > 0) {
                    result[i - 1] = { start: result[i - 1].start, end: result[i].end };
                    result.splice(i, 1);
                } else if (i < result.length - 1) {
                    result[i] = { start: result[i].start, end: result[i + 1].end };
                    result.splice(i + 1, 1);
                } else {
                    continue;
                }
                merged = true;
                break;
            }
        }
    }
    return result;
}

function adjustSegmentCount(segments, expectedCount, smoothed, totalLength) {
    if (expectedCount <= 0 || segments.length === expectedCount) return segments;

    const result = [...segments];
    const idealSize = totalLength / Math.max(1, expectedCount);
    const minSize = Math.max(2, Math.floor(idealSize * 0.25));
    const valleyMargin = Math.max(1, Math.floor(minSize * 0.5));

    const findValley = (start, end) => {
        let bestPos = Math.round((start + end) / 2);
        let minVal = Infinity;
        for (let x = start + valleyMargin; x < end - valleyMargin; x++) {
            if (x >= 0 && x < smoothed.length && smoothed[x] < minVal) {
                minVal = smoothed[x];
                bestPos = x;
            }
        }
        return bestPos;
    };

    while (result.length > expectedCount) {
        let bestIdx = -1, bestScore = Infinity;
        for (let i = 0; i < result.length - 1; i++) {
            const gap = result[i + 1].start - result[i].end;
            const combined = result[i + 1].end - result[i].start;
            const score = gap + Math.abs(combined - idealSize) * 0.2;
            if (score < bestScore) { bestScore = score; bestIdx = i; }
        }
        if (bestIdx >= 0) {
            result[bestIdx] = { start: result[bestIdx].start, end: result[bestIdx + 1].end };
            result.splice(bestIdx + 1, 1);
        } else break;
    }

    while (result.length < expectedCount) {
        let bestIdx = -1, bestWidth = 0;
        for (let i = 0; i < result.length; i++) {
            const w = result[i].end - result[i].start;
            if (w > bestWidth) { bestWidth = w; bestIdx = i; }
        }
        if (bestIdx >= 0 && bestWidth > minSize * 2) {
            const seg = result[bestIdx];
            let splitPos = findValley(seg.start, seg.end);
            if (splitPos - seg.start < minSize || seg.end - splitPos < minSize) {
                splitPos = Math.round((seg.start + seg.end) / 2);
            }
            result.splice(bestIdx, 1,
                { start: seg.start, end: splitPos },
                { start: splitPos, end: seg.end }
            );
        } else break;
    }

    return result;
}

/**
 * Simple, robust segmentation: heavy smoothing + anchor-based valley snap.
 * `anchorFractions` (optional): array of N-1 fractions from the original image's
 * actual cut positions. If provided, uses those instead of equidistant positions.
 */
/**
 * Detect grid lines by high-pass filtering: grid lines are thin sharp features
 * that exist in raw projection but are removed by heavy smoothing.
 */
function detectGridCuts(rawProj, count, secLen) {
    const expected = count - 1;
    if (expected <= 0) return null;

    const idealSize = secLen / count;
    const smoothW = Math.max(5, Math.floor(idealSize * 0.4));
    const smoothed = smoothProjection(Array.from(rawProj), smoothW);

    // High-pass: sharp features = raw - smoothed
    const gridSignal = rawProj.map((v, i) => Math.max(0, v - smoothed[i]));
    const maxGrid = Math.max(...gridSignal);
    if (maxGrid < 3) return null;

    // Find peaks in grid signal
    const peakThresh = maxGrid * 0.25;
    const minDist = idealSize * 0.4;
    const peaks = [];

    for (let i = 3; i < gridSignal.length - 3; i++) {
        if (gridSignal[i] < peakThresh) continue;
        if (gridSignal[i] >= gridSignal[i - 1] && gridSignal[i] >= gridSignal[i + 1] &&
            gridSignal[i] >= gridSignal[i - 2] && gridSignal[i] >= gridSignal[i + 2]) {
            if (peaks.length === 0 || i - peaks[peaks.length - 1] > minDist * 0.4) {
                peaks.push(i);
            }
        }
    }

    if (peaks.length < expected) return null;

    // Select top-N most prominent peaks
    if (peaks.length > expected) {
        const scored = peaks.map(p => ({ pos: p, val: gridSignal[p] }));
        scored.sort((a, b) => b.val - a.val);
        const selected = scored.slice(0, expected).map(s => s.pos).sort((a, b) => a - b);
        // Verify regularity
        const spacings = [];
        for (let i = 1; i < selected.length; i++) spacings.push(selected[i] - selected[i - 1]);
        if (spacings.length > 0) {
            const avg = spacings.reduce((a, b) => a + b, 0) / spacings.length;
            const maxDev = Math.max(...spacings.map(s => Math.abs(s - avg) / avg));
            if (maxDev > 0.5) return null;
        }
        console.log(`    [grid] Detected ${selected.length} grid lines from ${peaks.length} peaks`);
        return selected;
    }

    // Exact match — verify regularity
    const spacings = [];
    for (let i = 1; i < peaks.length; i++) spacings.push(peaks[i] - peaks[i - 1]);
    const avg = spacings.reduce((a, b) => a + b, 0) / spacings.length;
    const maxDev = Math.max(...spacings.map(s => Math.abs(s - avg) / avg));
    if (maxDev > 0.5) return null;

    console.log(`    [grid] Detected ${peaks.length} grid lines, spacing=${avg.toFixed(0)}, regularity=${(1 - maxDev).toFixed(2)}`);
    return peaks;
}

function equidistantSegments(secLen, count, rawProj, anchorFractions) {
    if (count <= 0) return { segments: [{ start: 0, end: secLen }], cutFractions: [] };
    if (count === 1) return { segments: [{ start: 0, end: secLen }], cutFractions: [] };

    // Priority 1: detect grid lines in the image (sharp thin features)
    const useAnchors = anchorFractions && anchorFractions.length === count - 1;
    if (!useAnchors) {
        const gridCuts = detectGridCuts(rawProj, count, secLen);
        if (gridCuts) {
            const cutFractions = gridCuts.map(c => c / secLen);
            // Find ink extent for start/end
            const inkThresh = Math.max(...rawProj) * 0.05;
            let gs = 0, ge = secLen;
            for (let i = 0; i < rawProj.length; i++) { if (rawProj[i] > inkThresh) { gs = Math.max(0, i - 3); break; } }
            for (let i = rawProj.length - 1; i >= 0; i--) { if (rawProj[i] > inkThresh) { ge = Math.min(secLen, i + 4); break; } }
            const allCuts = [gs, ...gridCuts, ge];
            const segments = [];
            for (let i = 0; i < allCuts.length - 1; i++) {
                if (allCuts[i + 1] > allCuts[i]) segments.push({ start: allCuts[i], end: allCuts[i + 1] });
            }
            const sizes = segments.map(s => s.end - s.start);
            console.log(`    [seg] GRID mode: ${segments.length} chars, sizes=[${sizes.join(',')}]`);
            return { segments: segments.length > 0 ? segments : [{ start: 0, end: secLen }], cutFractions };
        }
    }

    // Priority 2: ink-aware equidistant + valley snapping

    // Find actual ink extent to avoid blank margins
    const inkThreshold = Math.max(...rawProj) * 0.05;
    let inkStart = 0, inkEnd = secLen - 1;
    for (let i = 0; i < rawProj.length; i++) {
        if (rawProj[i] > inkThreshold) { inkStart = i; break; }
    }
    for (let i = rawProj.length - 1; i >= 0; i--) {
        if (rawProj[i] > inkThreshold) { inkEnd = i + 1; break; }
    }
    // Add small padding around ink extent
    const inkPad = Math.round((inkEnd - inkStart) / count * 0.08);
    inkStart = Math.max(0, inkStart - inkPad);
    inkEnd = Math.min(secLen, inkEnd + inkPad);
    const effectiveLen = inkEnd - inkStart;
    const idealSize = effectiveLen / count;

    // Heavy smoothing: 25% of char size eliminates fold lines, texture, internal gaps
    const smoothW = Math.max(5, Math.floor(idealSize * 0.25));
    const smoothed = smoothProjection(Array.from(rawProj), smoothW);

    const radius = Math.floor(idealSize * 0.25);
    const cuts = [];

    for (let i = 1; i < count; i++) {
        // Use original's proportions if available, otherwise equidistant within ink extent
        const nominal = useAnchors
            ? Math.round(anchorFractions[i - 1] * secLen)
            : Math.round(inkStart + i * idealSize);

        // Weighted valley search: prefer low ink AND proximity to nominal
        let bestPos = nominal;
        let bestScore = Infinity;
        const lo = Math.max(0, nominal - radius);
        const hi = Math.min(smoothed.length - 1, nominal + radius);
        const maxSmoothed = Math.max(...smoothed.slice(lo, hi + 1));
        for (let j = lo; j <= hi; j++) {
            const distPenalty = Math.abs(j - nominal) / radius; // 0..1
            const valleyScore = maxSmoothed > 0 ? smoothed[j] / maxSmoothed : 0; // 0..1
            const score = valleyScore * 0.7 + distPenalty * 0.3;
            if (score < bestScore) {
                bestScore = score;
                bestPos = j;
            }
        }
        cuts.push(bestPos);
    }

    // Ensure monotonically increasing
    for (let i = 1; i < cuts.length; i++) {
        if (cuts[i] <= cuts[i - 1]) {
            cuts[i] = cuts[i - 1] + Math.floor(idealSize * 0.5);
        }
    }

    // Record cut fractions for passing to practice image
    const cutFractions = cuts.map(c => c / secLen);

    console.log(`    [seg] secLen=${secLen}, count=${count}, ink=[${inkStart},${inkEnd}], ideal=${idealSize.toFixed(0)}, ` +
        `ref=${useAnchors ? 'original' : 'equidistant'}`);
    console.log(`    [seg] cuts: [${cuts.join(',')}]`);
    const allCuts = [inkStart, ...cuts, inkEnd];
    const sizes = [];
    for (let i = 0; i < allCuts.length - 1; i++) sizes.push(allCuts[i + 1] - allCuts[i]);
    console.log(`    [seg] sizes: [${sizes.join(',')}]`);

    const segments = [];
    for (let i = 0; i < allCuts.length - 1; i++) {
        if (allCuts[i + 1] > allCuts[i]) {
            segments.push({ start: allCuts[i], end: allCuts[i + 1] });
        }
    }
    return {
        segments: segments.length > 0 ? segments : [{ start: 0, end: secLen }],
        cutFractions
    };
}

function trimCharacter(sourceCanvas, cx, cy, cw, ch, pixelData, fullW, fullH, isInk) {
    let tMinX = cw, tMinY = ch, tMaxX = 0, tMaxY = 0;
    let found = false;

    for (let dy = 0; dy < ch; dy++) {
        for (let dx = 0; dx < cw; dx++) {
            const sx = cx + dx;
            const sy = cy + dy;
            if (sx < 0 || sx >= fullW || sy < 0 || sy >= fullH) continue;
            const i = (sy * fullW + sx) * 4;
            const brightness = (pixelData[i] + pixelData[i + 1] + pixelData[i + 2]) / 3;
            if (isInk(brightness)) {
                found = true;
                tMinX = Math.min(tMinX, dx);
                tMinY = Math.min(tMinY, dy);
                tMaxX = Math.max(tMaxX, dx);
                tMaxY = Math.max(tMaxY, dy);
            }
        }
    }

    if (!found) return null;

    const inkW = tMaxX - tMinX + 1;
    const inkH = tMaxY - tMinY + 1;
    if (inkW < 3 || inkH < 3) return null;

    // Create a square canvas with the character centered (no extra padding)
    const maxDim = Math.max(inkW, inkH);
    const canvasSize = maxDim;

    const charCanvas = document.createElement('canvas');
    charCanvas.width = canvasSize;
    charCanvas.height = canvasSize;
    const ctx = charCanvas.getContext('2d');

    // Fill with the background color from source (sample corner pixel)
    const srcCtx = sourceCanvas.getContext('2d');
    const cornerData = srcCtx.getImageData(0, 0, 1, 1).data;
    ctx.fillStyle = `rgb(${cornerData[0]},${cornerData[1]},${cornerData[2]})`;
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    // Draw centered
    const drawX = Math.round((maxDim - inkW) / 2);
    const drawY = Math.round((maxDim - inkH) / 2);
    ctx.drawImage(
        sourceCanvas, cx + tMinX, cy + tMinY, inkW, inkH,
        drawX, drawY, inkW, inkH
    );
    return charCanvas;
}

/**
 * Extract text region from image: returns { textCanvas, textW, textH, textIsInk } or null.
 */
function extractTextRegion(img) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(img, 0, 0);

    const fullData = tempCtx.getImageData(0, 0, img.width, img.height).data;
    const { isInk } = getAdaptiveThreshold(fullData, img.width, img.height);

    let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
    let foundPixel = false;
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * 4;
            const brightness = (fullData[i] + fullData[i + 1] + fullData[i + 2]) / 3;
            if (isInk(brightness)) {
                foundPixel = true;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
    }
    if (!foundPixel) return null;

    const padding = 10;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(img.width, maxX + padding);
    maxY = Math.min(img.height, maxY + padding);

    const textW = maxX - minX;
    const textH = maxY - minY;
    if (textW <= 0 || textH <= 0) return null;

    const textCanvas = document.createElement('canvas');
    textCanvas.width = textW;
    textCanvas.height = textH;
    textCanvas.getContext('2d').drawImage(img, minX, minY, textW, textH, 0, 0, textW, textH);
    const textData = textCanvas.getContext('2d').getImageData(0, 0, textW, textH).data;
    const { isInk: textIsInk } = getAdaptiveThreshold(textData, textW, textH);

    return { textCanvas, textW, textH, textData, textIsInk, offsetX: minX, offsetY: minY };
}

/**
 * Segment image into line/column canvases only (no per-char splitting).
 */
function segmentLines(img, direction, lineCountHint, manualPrimarySegs) {
    const region = extractTextRegion(img);
    if (!region) return { lines: [], debugInfo: null };
    const { textCanvas, textW, textH, textData, textIsInk, offsetX: regionOX, offsetY: regionOY } = region;

    const primaryAxis = direction === 'vertical' ? 'x' : 'y';
    const primaryLen = primaryAxis === 'x' ? textW : textH;
    const primaryProj = computeProjection(textData, textW, textH, primaryAxis, textIsInk);
    const smoothW = Math.max(5, Math.floor(primaryLen * 0.008));
    const primarySmoothed = smoothProjection(primaryProj, smoothW);

    let primarySegs;
    if (manualPrimarySegs) {
        primarySegs = manualPrimarySegs;
    } else {
        primarySegs = findPrimarySegments(primarySmoothed, primaryLen);
        if (lineCountHint > 0) {
            primarySegs = adjustSegmentCount(primarySegs, lineCountHint, primarySmoothed, primaryLen);
        }
        if (direction === 'vertical') primarySegs.reverse();
    }

    const lines = [];
    for (const seg of primarySegs) {
        let lw, lh, ox, oy;
        if (primaryAxis === 'x') {
            lw = seg.end - seg.start; lh = textH; ox = seg.start; oy = 0;
        } else {
            lw = textW; lh = seg.end - seg.start; ox = 0; oy = seg.start;
        }
        if (lw < 1 || lh < 1) continue;
        const lineCanvas = document.createElement('canvas');
        lineCanvas.width = lw;
        lineCanvas.height = lh;
        lineCanvas.getContext('2d').drawImage(textCanvas, ox, oy, lw, lh, 0, 0, lw, lh);
        lines.push(lineCanvas);
    }

    const debugInfo = {
        regionOX, regionOY, textW, textH,
        primaryAxis, primarySegs,
        debugLines: [] // no secondary cuts in line mode
    };

    return { lines, debugInfo };
}

/**
 * 2D segmentation: split image into individual character canvases.
 * direction = 'vertical':  X-projection → columns (right-to-left), then Y-projection → chars (top-to-bottom)
 * direction = 'horizontal': Y-projection → rows (top-to-bottom), then X-projection → chars (left-to-right)
 *
 * charsPerLineHints: array of per-column/row char counts (reading order).
 *   [] = auto-detect all
 *   [9] = uniform 9 for all columns
 *   [9,9,9,9,11,10] = per-column counts
 */
function segment2D(img, direction, lineCountHint, charsPerLineHints, refCutFractions, manualCuts, manualPrimarySegs) {
    const region = extractTextRegion(img);
    if (!region) return { characters: [], cutFractions: [], debugInfo: null };
    const { textCanvas, textW, textH, textData, textIsInk, offsetX: regionOX, offsetY: regionOY } = region;

    const primaryAxis = direction === 'vertical' ? 'x' : 'y';
    const primaryLen = primaryAxis === 'x' ? textW : textH;

    let primarySegs;
    if (manualPrimarySegs) {
        // Use manually adjusted primary segments directly
        primarySegs = manualPrimarySegs;
    } else {
        const primaryProj = computeProjection(textData, textW, textH, primaryAxis, textIsInk);
        const smoothW = Math.max(5, Math.floor(primaryLen * 0.008));
        const primarySmoothed = smoothProjection(primaryProj, smoothW);
        primarySegs = findPrimarySegments(primarySmoothed, primaryLen);

        if (lineCountHint > 0) {
            primarySegs = adjustSegmentCount(primarySegs, lineCountHint, primarySmoothed, primaryProj.length);
        }
        if (direction === 'vertical') primarySegs.reverse();

        // Expand primary segments slightly to avoid clipping edge characters
        const expandPx = Math.max(3, Math.round(primaryLen / primarySegs.length * 0.03));
        for (const seg of primarySegs) {
            seg.start = Math.max(0, seg.start - expandPx);
            seg.end = Math.min(primaryLen, seg.end + expandPx);
        }
    }

    console.log(`[segment2D] direction=${direction}, primary(${primaryAxis}): ${primarySegs.length} segments`);

    // Phase 1: initial segmentation of each line
    const lineInfos = [];
    for (const lineSeg of primarySegs) {
        let lineW, lineH, offsetX, offsetY;
        if (primaryAxis === 'x') {
            lineW = lineSeg.end - lineSeg.start; lineH = textH;
            offsetX = lineSeg.start; offsetY = 0;
        } else {
            lineW = textW; lineH = lineSeg.end - lineSeg.start;
            offsetX = 0; offsetY = lineSeg.start;
        }

        const lineCanvas = document.createElement('canvas');
        lineCanvas.width = lineW;
        lineCanvas.height = lineH;
        lineCanvas.getContext('2d').drawImage(
            textCanvas, offsetX, offsetY, lineW, lineH, 0, 0, lineW, lineH
        );

        const lineData = lineCanvas.getContext('2d').getImageData(0, 0, lineW, lineH).data;
        const { isInk: lineIsInk } = getAdaptiveThreshold(lineData, lineW, lineH);

        const secAxis = primaryAxis === 'x' ? 'y' : 'x';
        const secLen = secAxis === 'x' ? lineW : lineH;
        const secProj = computeProjection(lineData, lineW, lineH, secAxis, lineIsInk);
        const lineThickness = primaryAxis === 'x' ? lineW : lineH;

        // Direction-aware parameters:
        // Vertical columns → split along Y: chars are square-ish, strong anti-split
        // Horizontal rows → split along X: lighter touch, row height may be inflated by ruled lines
        let secSmoothW, valleyRatio, mergeThreshold;
        if (direction === 'vertical') {
            secSmoothW = Math.max(5, Math.floor(lineThickness * 0.15));
            valleyRatio = 0.20;
            mergeThreshold = lineThickness * 0.7;
        } else {
            // For horizontal: estimate actual char height from ink bounding box
            let inkMinY = lineH, inkMaxY = 0;
            for (let y = 0; y < lineH; y++) {
                for (let x = 0; x < lineW; x++) {
                    const idx = (y * lineW + x) * 4;
                    const br = (lineData[idx] + lineData[idx+1] + lineData[idx+2]) / 3;
                    if (lineIsInk(br)) { inkMinY = Math.min(inkMinY, y); inkMaxY = Math.max(inkMaxY, y); }
                }
            }
            const actualCharH = inkMaxY > inkMinY ? inkMaxY - inkMinY : lineH;
            secSmoothW = Math.max(3, Math.floor(actualCharH * 0.06));
            valleyRatio = 0.12;
            mergeThreshold = actualCharH * 0.35;
        }

        const secSmoothed = smoothProjection(secProj, secSmoothW);
        let charSegs = findSegmentsFromProjection(secSmoothed, secLen, valleyRatio);
        charSegs = mergeSmallSegments(charSegs, mergeThreshold);

        lineInfos.push({ lineCanvas, lineData, lineIsInk, secAxis, secLen, secProj, secSmoothed, charSegs, lineThickness, lineSeg });
    }

    // Phase 2: determine per-column/row char counts
    // charsPerLineHints: [] = auto, [N] = uniform N, [a,b,c,...] = per-column
    const isUniform = direction === 'vertical';
    const perColumnTargets = new Array(lineInfos.length).fill(0);

    if (charsPerLineHints.length === 1) {
        // Single number: apply uniformly to all columns
        perColumnTargets.fill(charsPerLineHints[0]);
    } else if (charsPerLineHints.length > 1) {
        // Per-column specification
        for (let i = 0; i < lineInfos.length; i++) {
            perColumnTargets[i] = i < charsPerLineHints.length ? charsPerLineHints[i] : 0;
        }
    } else if (isUniform) {
        // Auto-detect uniform count for vertical calligraphy via mode
        const counts = lineInfos.map(li => li.charSegs.length);
        const freq = {};
        for (const c of counts) freq[c] = (freq[c] || 0) + 1;
        let modeCount = counts[0] || 1, modeFreq = 0;
        for (const [count, f] of Object.entries(freq)) {
            if (f > modeFreq || (f === modeFreq && Number(count) > modeCount)) {
                modeCount = Number(count);
                modeFreq = f;
            }
        }
        perColumnTargets.fill(modeCount);
        console.log(`[segment2D] auto uniform: mode=${modeCount} from counts=[${counts}]`);
    }
    // else: all zeros → each row uses its own Phase 1 detection

    // Phase 3: finalize segments per line using anchor-based valley refinement
    const characters = [];
    const allCutFractions = []; // per-column cut fractions for passing to practice
    const debugLines = []; // for cut line visualization
    for (let idx = 0; idx < lineInfos.length; idx++) {
        const li = lineInfos[idx];
        let charSegs = li.charSegs;
        const target = perColumnTargets[idx];
        let cutFractions = [];

        if (manualCuts && manualCuts[idx]) {
            // Manual cuts provided — use them directly, no snapping
            const mc = manualCuts[idx];
            // Support both array format [c1,c2,...] and object format {cuts:[...], endPos:N}
            const cuts = mc.cuts || mc;
            const endPos = mc.endPos !== undefined ? mc.endPos : li.secLen;
            const allManual = [0, ...cuts, endPos];
            charSegs = [];
            for (let m = 0; m < allManual.length - 1; m++) {
                if (allManual[m + 1] > allManual[m]) {
                    charSegs.push({ start: allManual[m], end: allManual[m + 1] });
                }
            }
            cutFractions = cuts.map(c => c / li.secLen);
            console.log(`    [manual] col ${idx}: ${charSegs.length} chars, endPos=${endPos}/${li.secLen}`);
        } else if (target > 0) {
            // Use original's cut fractions as anchors if available for this column
            const ref = refCutFractions ? refCutFractions[idx] : null;
            const result = equidistantSegments(li.secLen, target, li.secProj, ref);
            charSegs = result.segments;
            cutFractions = result.cutFractions;
        }
        allCutFractions.push(cutFractions);
        debugLines.push({ lineSeg: li.lineSeg, charSegs, secAxis: li.secAxis });

        console.log(`  line ${idx} [${li.lineSeg.start}-${li.lineSeg.end}]: ${charSegs.length} chars` +
            (target > 0 ? ` (target=${target})` : ' (auto)'));

        for (const charSeg of charSegs) {
            let cx, cy, cw, ch;
            if (li.secAxis === 'y') {
                cx = 0; cy = charSeg.start; cw = li.lineCanvas.width; ch = charSeg.end - charSeg.start;
            } else {
                cx = charSeg.start; cy = 0; cw = charSeg.end - charSeg.start; ch = li.lineCanvas.height;
            }
            const trimmed = trimCharacter(li.lineCanvas, cx, cy, cw, ch, li.lineData, li.lineCanvas.width, li.lineCanvas.height, li.lineIsInk);
            if (trimmed) characters.push(trimmed);
        }
    }

    const debugInfo = {
        regionOX, regionOY, textW, textH,
        primaryAxis, primarySegs, debugLines
    };
    return { characters, cutFractions: allCutFractions, debugInfo };
}

/**
 * Draw cut lines on a copy of the source image for visualization.
 * Red lines = primary (column/row boundaries), blue lines = secondary (char boundaries).
 */
function drawCutLines(img, debugInfo) {
    if (!debugInfo) return null;
    const { regionOX, regionOY, primaryAxis, primarySegs, debugLines } = debugInfo;

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const lineWidth = Math.max(2, Math.round(Math.max(img.width, img.height) / 500));

    // Draw primary segment boundaries (red) — column/row edges
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.7)';
    ctx.lineWidth = lineWidth;
    for (const seg of primarySegs) {
        if (primaryAxis === 'x') {
            // Vertical columns: draw vertical lines at column boundaries
            const x1 = regionOX + seg.start;
            const x2 = regionOX + seg.end;
            ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, img.height); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, img.height); ctx.stroke();
        } else {
            // Horizontal rows: draw horizontal lines at row boundaries
            const y1 = regionOY + seg.start;
            const y2 = regionOY + seg.end;
            ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(img.width, y1); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, y2); ctx.lineTo(img.width, y2); ctx.stroke();
        }
    }

    // Draw secondary segment boundaries (blue) — char cuts within each column/row
    ctx.strokeStyle = 'rgba(0, 100, 255, 0.6)';
    ctx.lineWidth = Math.max(1, lineWidth - 1);
    for (const dl of debugLines) {
        const { lineSeg, charSegs, secAxis } = dl;
        for (const cs of charSegs) {
            if (secAxis === 'y') {
                // Chars split along Y within a vertical column
                const x1 = regionOX + lineSeg.start;
                const x2 = regionOX + lineSeg.end;
                const y = regionOY + cs.start;
                ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
                const y2 = regionOY + cs.end;
                ctx.beginPath(); ctx.moveTo(x1, y2); ctx.lineTo(x2, y2); ctx.stroke();
            } else {
                // Chars split along X within a horizontal row
                const y1 = regionOY + lineSeg.start;
                const y2 = regionOY + lineSeg.end;
                const x = regionOX + cs.start;
                ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke();
                const x2 = regionOX + cs.end;
                ctx.beginPath(); ctx.moveTo(x2, y1); ctx.lineTo(x2, y2); ctx.stroke();
            }
        }
    }

    // Number each cell
    ctx.font = `bold ${Math.max(14, Math.round(img.width / 60))}px sans-serif`;
    ctx.fillStyle = 'rgba(255, 50, 50, 0.85)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let charIdx = 1;
    for (const dl of debugLines) {
        const { lineSeg, charSegs, secAxis } = dl;
        for (const cs of charSegs) {
            let cx, cy;
            if (secAxis === 'y') {
                cx = regionOX + (lineSeg.start + lineSeg.end) / 2;
                cy = regionOY + cs.start + 2;
            } else {
                cx = regionOX + cs.start + 2;
                cy = regionOY + (lineSeg.start + lineSeg.end) / 2;
            }
            ctx.fillText(String(charIdx), cx, cy);
            charIdx++;
        }
    }

    return canvas;
}

// ============================================================
// Interactive cut line editing
// ============================================================

const editStates = {};

function setupInteractiveCutLines(canvasEl, img, debugInfo) {
    if (!debugInfo) return null;
    const { regionOX, regionOY, primaryAxis, primarySegs, debugLines, textW, textH } = debugInfo;

    // Editable primary edges (column/row boundaries)
    const primaryEdges = primarySegs.map(seg => ({
        start: seg.start, end: seg.end,
        origStart: seg.start, origEnd: seg.end
    }));

    // Editable columns with secondary cuts + end terminators
    const columns = debugLines.map((dl) => {
        const { lineSeg, charSegs, secAxis } = dl;
        const cuts = [];
        for (let i = 0; i < charSegs.length - 1; i++) {
            cuts.push(charSegs[i].end);
        }
        const secLen = charSegs.length > 0 ? charSegs[charSegs.length - 1].end : 0;
        return {
            lineSeg: { start: lineSeg.start, end: lineSeg.end },
            secAxis, cuts, origCuts: [...cuts],
            endPos: secLen, origEndPos: secLen, secLen
        };
    });

    const primaryLen = primaryAxis === 'x' ? textW : textH;
    const secDimLen = primaryAxis === 'x' ? img.height : img.width;

    // For line mode: add per-column top/bottom bounds for height adjustment
    if (columns.length === 0) {
        const secOffset = primaryAxis === 'x' ? regionOY : regionOX;
        const secTextLen = primaryAxis === 'x' ? textH : textW;
        for (const pe of primaryEdges) {
            pe.topPos = secOffset;
            pe.bottomPos = secOffset + secTextLen;
            pe.origTopPos = secOffset;
            pe.origBottomPos = secOffset + secTextLen;
        }
    }

    // Count total cells and pre-select all
    const selectedCells = new Set();
    let totalCells = 0;
    if (columns.length === 0) {
        // Line mode: each primary segment is a cell
        for (let i = 0; i < primaryEdges.length; i++) {
            selectedCells.add(i);
            totalCells++;
        }
    } else {
        for (const col of columns) {
            const allCuts = [0, ...col.cuts, col.endPos];
            for (let i = 0; i < allCuts.length - 1; i++) {
                if (allCuts[i + 1] > allCuts[i]) {
                    selectedCells.add(totalCells);
                    totalCells++;
                }
            }
        }
    }

    const state = {
        canvas: canvasEl, ctx: canvasEl.getContext('2d'),
        img, regionOX, regionOY,
        primaryAxis, primaryLen, primaryEdges, columns,
        secDimLen,
        dragging: null, hovered: null, selected: null, modified: false,
        selectedCells
    };

    editStates[canvasEl.id] = state;
    drawEditablePreview(state);

    canvasEl.onmousedown = (e) => onEditMouseDown(state, e);
    canvasEl.onmousemove = (e) => onEditMouseMove(state, e);
    canvasEl.onmouseup = (e) => onEditMouseUp(state, e);
    canvasEl.onmouseleave = (e) => onEditMouseUp(state, e);
    canvasEl.onkeydown = (e) => onEditKeyDown(state, e);
    canvasEl.ondblclick = (e) => onEditDblClick(state, e);
    canvasEl.tabIndex = 0;
    canvasEl.style.outline = 'none';

    canvasEl.ontouchstart = (e) => {
        const t = e.touches[0];
        onEditMouseDown(state, { clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() });
    };
    canvasEl.ontouchmove = (e) => {
        const t = e.touches[0];
        onEditMouseMove(state, { clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() });
    };
    canvasEl.ontouchend = (e) => onEditMouseUp(state, e);

    return state;
}

function getCanvasCoords(state, e) {
    const rect = state.canvas.getBoundingClientRect();
    const scaleX = state.canvas.width / rect.width;
    const scaleY = state.canvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}

function getCursorForHit(state, hit) {
    if (hit.type === 'primary') {
        return state.primaryAxis === 'x' ? 'col-resize' : 'row-resize';
    }
    if (hit.type === 'lineTop' || hit.type === 'lineBottom') {
        return state.primaryAxis === 'x' ? 'row-resize' : 'col-resize';
    }
    // secondary and end: move along secondary axis
    const col = state.columns[hit.colIdx];
    return col.secAxis === 'y' ? 'row-resize' : 'col-resize';
}

function findNearestLine(state, cx, cy) {
    const threshold = Math.max(8, Math.max(state.canvas.width, state.canvas.height) / 120);
    let best = null, bestDist = Infinity;

    // Check primary edges (column/row boundaries) — with perpendicular range check
    for (let segIdx = 0; segIdx < state.primaryEdges.length; segIdx++) {
        const pe = state.primaryEdges[segIdx];
        for (const edge of ['start', 'end']) {
            const pos = pe[edge];
            // Skip if this edge is same position as an adjacent edge (avoid duplicates)
            if (edge === 'end' && segIdx < state.primaryEdges.length - 1 &&
                Math.abs(pe.end - state.primaryEdges[segIdx + 1].start) < 3) continue;

            let dist;
            if (state.primaryAxis === 'x') {
                // Only detect within the text region height
                if (cy < state.regionOY - threshold || cy > state.regionOY + (state.img.height - state.regionOY) + threshold) {
                    dist = Infinity;
                } else {
                    dist = Math.abs(cx - (state.regionOX + pos));
                }
            } else {
                if (cx < state.regionOX - threshold || cx > state.regionOX + (state.img.width - state.regionOX) + threshold) {
                    dist = Infinity;
                } else {
                    dist = Math.abs(cy - (state.regionOY + pos));
                }
            }
            if (dist < bestDist && dist < threshold) {
                bestDist = dist;
                best = { type: 'primary', segIdx, edge };
            }
        }
    }

    // Check line mode top/bottom bounds
    if (state.columns.length === 0) {
        for (let segIdx = 0; segIdx < state.primaryEdges.length; segIdx++) {
            const pe = state.primaryEdges[segIdx];
            if (pe.topPos === undefined) continue;

            const pOffset = state.primaryAxis === 'x' ? state.regionOX : state.regionOY;
            const pStart = pOffset + Math.min(pe.start, pe.end);
            const pEnd = pOffset + Math.max(pe.start, pe.end);
            const pCoord = state.primaryAxis === 'x' ? cx : cy;

            if (pCoord < pStart - threshold || pCoord > pEnd + threshold) continue;

            const sCoord = state.primaryAxis === 'x' ? cy : cx;

            const topDist = Math.abs(sCoord - pe.topPos);
            if (topDist < bestDist && topDist < threshold) {
                bestDist = topDist;
                best = { type: 'lineTop', segIdx };
            }

            const bottomDist = Math.abs(sCoord - pe.bottomPos);
            if (bottomDist < bestDist && bottomDist < threshold) {
                bestDist = bottomDist;
                best = { type: 'lineBottom', segIdx };
            }
        }
    }

    // Check secondary cuts and end terminators
    for (let colIdx = 0; colIdx < state.columns.length; colIdx++) {
        const col = state.columns[colIdx];
        const x1 = state.regionOX + col.lineSeg.start;
        const x2 = state.regionOX + col.lineSeg.end;
        const y1 = state.regionOY + col.lineSeg.start;
        const y2 = state.regionOY + col.lineSeg.end;

        // Secondary cuts
        for (let cutIdx = 0; cutIdx < col.cuts.length; cutIdx++) {
            let dist;
            if (col.secAxis === 'y') {
                const y = state.regionOY + col.cuts[cutIdx];
                dist = (cx >= x1 - threshold && cx <= x2 + threshold) ? Math.abs(cy - y) : Infinity;
            } else {
                const x = state.regionOX + col.cuts[cutIdx];
                dist = (cy >= y1 - threshold && cy <= y2 + threshold) ? Math.abs(cx - x) : Infinity;
            }
            if (dist < bestDist && dist < threshold) {
                bestDist = dist;
                best = { type: 'secondary', colIdx, cutIdx };
            }
        }

        // End terminator
        let endDist;
        if (col.secAxis === 'y') {
            const y = state.regionOY + col.endPos;
            endDist = (cx >= x1 - threshold && cx <= x2 + threshold) ? Math.abs(cy - y) : Infinity;
        } else {
            const x = state.regionOX + col.endPos;
            endDist = (cy >= y1 - threshold && cy <= y2 + threshold) ? Math.abs(cx - x) : Infinity;
        }
        if (endDist < bestDist && endDist < threshold) {
            bestDist = endDist;
            best = { type: 'end', colIdx };
        }
    }

    return best;
}

function getLinePos(state, hit) {
    if (hit.type === 'primary') {
        return state.primaryEdges[hit.segIdx][hit.edge];
    } else if (hit.type === 'secondary') {
        return state.columns[hit.colIdx].cuts[hit.cutIdx];
    } else if (hit.type === 'end') {
        return state.columns[hit.colIdx].endPos;
    } else if (hit.type === 'lineTop') {
        return state.primaryEdges[hit.segIdx].topPos;
    } else if (hit.type === 'lineBottom') {
        return state.primaryEdges[hit.segIdx].bottomPos;
    }
    return 0;
}

// Move a primary edge to newPos, clamping within own segment and syncing shared boundaries
function movePrimaryEdge(state, segIdx, edge, newPos) {
    const pe = state.primaryEdges[segIdx];
    const minGap = 10;
    const oldPos = pe[edge];

    // Clamp against own segment's other edge AND adjacent segments
    let lo, hi;
    if (edge === 'start') {
        lo = 0;
        hi = pe.end - minGap;
        // Don't cross into previous segment
        for (let i = 0; i < state.primaryEdges.length; i++) {
            if (i === segIdx) continue;
            const o = state.primaryEdges[i];
            // If another segment's end was at (or near) our start, keep gap
            if (o.end <= pe.start + 3 && o.end > lo) {
                lo = Math.max(lo, o.start + minGap);
            }
        }
    } else {
        lo = pe.start + minGap;
        hi = state.primaryLen;
        // Don't cross into next segment
        for (let i = 0; i < state.primaryEdges.length; i++) {
            if (i === segIdx) continue;
            const o = state.primaryEdges[i];
            // If another segment's start was at (or near) our end, keep gap
            if (o.start >= pe.end - 3 && o.end < hi) {
                hi = Math.min(hi, o.end - minGap);
            }
        }
    }
    const clamped = Math.max(lo, Math.min(hi, Math.round(newPos)));
    pe[edge] = clamped;

    // Sync shared boundary with adjacent segment
    for (let i = 0; i < state.primaryEdges.length; i++) {
        if (i === segIdx) continue;
        const other = state.primaryEdges[i];
        if (Math.abs(other.start - oldPos) < 3) {
            other.start = clamped;
            if (i < state.columns.length) {
                state.columns[i].lineSeg = { start: other.start, end: other.end };
            }
        }
        if (Math.abs(other.end - oldPos) < 3) {
            other.end = clamped;
            if (i < state.columns.length) {
                state.columns[i].lineSeg = { start: other.start, end: other.end };
            }
        }
    }
    if (segIdx < state.columns.length) {
        state.columns[segIdx].lineSeg = { start: pe.start, end: pe.end };
    }
}

// Find which cell (0-based char index) a canvas coordinate falls inside
function findCell(state, cx, cy) {
    const { regionOX, regionOY, primaryEdges, columns } = state;

    // Line mode: no columns — map directly to primary segment index
    if (columns.length === 0) {
        for (let si = 0; si < primaryEdges.length; si++) {
            const pe = primaryEdges[si];
            const offset = state.primaryAxis === 'x' ? regionOX : regionOY;
            const coord = state.primaryAxis === 'x' ? cx : cy;
            const lo = offset + Math.min(pe.start, pe.end);
            const hi = offset + Math.max(pe.start, pe.end);
            if (coord < lo || coord > hi) continue;
            // Check secondary axis bounds (top/bottom)
            if (pe.topPos !== undefined) {
                const sCoord = state.primaryAxis === 'x' ? cy : cx;
                if (sCoord < pe.topPos || sCoord > pe.bottomPos) continue;
            }
            return si;
        }
        return -1;
    }

    let charIdx = 0;
    for (let ci = 0; ci < columns.length; ci++) {
        const col = columns[ci];
        const { lineSeg, cuts, secAxis, endPos } = col;
        const pe = primaryEdges[ci];
        // primary bounds in canvas coords
        const pStart = (state.primaryAxis === 'x' ? regionOX : regionOY) + pe.start;
        const pEnd = (state.primaryAxis === 'x' ? regionOX : regionOY) + pe.end;
        // check if cursor is within this column's primary range
        const pCoord = state.primaryAxis === 'x' ? cx : cy;
        if (pCoord < Math.min(pStart, pEnd) || pCoord > Math.max(pStart, pEnd)) {
            // count chars in this column and skip
            const allCuts = [0, ...cuts, endPos];
            for (let i = 0; i < allCuts.length - 1; i++) {
                if (allCuts[i + 1] > allCuts[i]) charIdx++;
            }
            continue;
        }
        // check secondary segments
        const secOffset = secAxis === 'y' ? regionOY : regionOX;
        const sCoord = secAxis === 'y' ? cy : cx;
        const allCuts = [0, ...cuts, endPos];
        for (let i = 0; i < allCuts.length - 1; i++) {
            if (allCuts[i + 1] <= allCuts[i]) continue;
            const sStart = secOffset + allCuts[i];
            const sEnd = secOffset + allCuts[i + 1];
            if (sCoord >= sStart && sCoord <= sEnd) {
                return charIdx;
            }
            charIdx++;
        }
        return -1; // within column but not in any cell
    }
    return -1;
}

function syncSelectionToCheckboxes(state) {
    // Only sync from original image canvas (cutLinesCanvas1)
    if (state.canvas.id !== 'cutLinesCanvas1') return;
    // Try both char and line checkboxes
    let checkboxes = comparisonGrid.querySelectorAll('.char-select-cb');
    let updateFn = updateSelectionCount;
    if (checkboxes.length === 0) {
        checkboxes = comparisonGrid.querySelectorAll('.line-select-cb');
        updateFn = updateLineSelectionCount;
    }
    if (checkboxes.length === 0) return;
    _syncing = true;
    checkboxes.forEach(cb => {
        const idx = parseInt(cb.dataset.index);
        const shouldCheck = state.selectedCells.has(idx);
        if (cb.checked !== shouldCheck) {
            cb.checked = shouldCheck;
            const row = cb.closest('.character-row');
            if (row) row.classList.toggle('char-unselected', !shouldCheck);
        }
    });
    _syncing = false;
    updateFn();
}

let _syncing = false;

function syncCheckboxToPreview() {
    if (_syncing) return;
    const state = editStates['cutLinesCanvas1'];
    if (!state) return;
    let checkboxes = comparisonGrid.querySelectorAll('.char-select-cb');
    if (checkboxes.length === 0) checkboxes = comparisonGrid.querySelectorAll('.line-select-cb');
    state.selectedCells.clear();
    checkboxes.forEach(cb => {
        if (cb.checked) state.selectedCells.add(parseInt(cb.dataset.index));
    });
    drawEditablePreview(state);
}

// ============================================================
// Pick Mode: double-click to manually build comparison list
// ============================================================
let pickModeActive = false;
let pickList = [];       // [{cellIdx, source:'orig'|'practice'}, ...]
let pickUndoStack = [];  // [{action:'add'|'remove', item, position}, ...]

let _savedPairs = null;
let _savedTitle = '';

let _savedLinePairs = null;

function togglePickMode() {
    pickModeActive = !pickModeActive;
    const btn = document.getElementById('pickModeBtn');
    const panel = document.getElementById('pickModePanel');
    const compareMode = compareModeSelect.value;
    btn.classList.toggle('pick-active', pickModeActive);
    btn.textContent = pickModeActive ? '📌 退出手动选字' : '📌 手动选字模式';
    panel.style.display = pickModeActive ? '' : 'none';
    if (pickModeActive) {
        // Save current comparison state
        _savedPairs = lastPairs.slice();
        _savedLinePairs = lastLinePairs.slice();
        _savedTitle = document.getElementById('resultsTitle').textContent;
        pickList = [];
        pickUndoStack = [];
        pickRefreshComparison();
    } else {
        // Restore previous comparison
        if (compareMode === 'line') {
            if (_savedLinePairs && _savedLinePairs.length > 0) {
                lastLinePairs = _savedLinePairs;
                document.getElementById('resultsTitle').textContent = _savedTitle;
                displayLineComparison(lastLinePairs, lastLines1.length, lastLines2.length);
            }
        } else {
            if (_savedPairs && _savedPairs.length > 0) {
                lastPairs = _savedPairs;
                document.getElementById('resultsTitle').textContent = _savedTitle;
                displayCharComparison(lastPairs, lastChars1.length, lastChars2.length, false);
            }
        }
        _savedPairs = null;
        _savedLinePairs = null;
        // Restore full selection highlights
        for (const canvasId of ['cutLinesCanvas1', 'cutLinesCanvas2']) {
            const state = editStates[canvasId];
            if (!state) continue;
            state.selectedCells.clear();
            const count = state.primaryEdges.length;
            for (let i = 0; i < count; i++) state.selectedCells.add(i);
            drawEditablePreview(state);
        }
    }
}

function pickAddChar(cellIdx, source) {
    const item = { cellIdx, source };
    pickList.push(item);
    pickUndoStack.push({ action: 'add', item, position: pickList.length - 1 });
    pickRefreshComparison();
    updatePickHighlights();
}

function pickRemoveAt(position) {
    if (position < 0 || position >= pickList.length) return;
    const item = pickList.splice(position, 1)[0];
    pickUndoStack.push({ action: 'remove', item, position });
    pickRefreshComparison();
    updatePickHighlights();
}

function pickUndo() {
    if (pickUndoStack.length === 0) return;
    const op = pickUndoStack.pop();
    if (op.action === 'add') {
        // Undo an add → remove the item
        const idx = pickList.indexOf(op.item);
        if (idx >= 0) pickList.splice(idx, 1);
    } else if (op.action === 'remove') {
        // Undo a remove → re-insert at original position
        pickList.splice(Math.min(op.position, pickList.length), 0, op.item);
    }
    pickRefreshComparison();
    updatePickHighlights();
}

function pickClear() {
    if (pickList.length === 0) return;
    // Push a batch undo entry
    const items = [...pickList];
    pickUndoStack.push({ action: 'clear', items });
    pickList = [];
    pickRefreshComparison();
    updatePickHighlights();
}

// Override pickUndo to handle 'clear' and 'removePair'
const _origPickUndo = pickUndo;
pickUndo = function () {
    if (pickUndoStack.length === 0) return;
    const op = pickUndoStack[pickUndoStack.length - 1];
    if (op.action === 'clear' || op.action === 'removePair') {
        pickUndoStack.pop();
        // Re-insert all removed items at their original positions
        for (const item of op.items) {
            pickList.push(item);
        }
        pickRefreshComparison();
        updatePickHighlights();
    } else {
        _origPickUndo();
    }
};

function extractCharFromEditState(state, cellIdx) {
    const { img, regionOX, regionOY, primaryAxis, primaryEdges, columns } = state;

    // Line mode: no columns — cellIdx maps directly to primary segment
    if (columns.length === 0) {
        if (cellIdx < 0 || cellIdx >= primaryEdges.length) return null;
        const pe = primaryEdges[cellIdx];
        let cx, cy, cw, ch;
        if (primaryAxis === 'x') {
            cx = regionOX + Math.min(pe.start, pe.end);
            cw = Math.abs(pe.end - pe.start);
            cy = pe.topPos !== undefined ? pe.topPos : 0;
            ch = (pe.bottomPos !== undefined ? pe.bottomPos : img.height) - cy;
        } else {
            cy = regionOY + Math.min(pe.start, pe.end);
            ch = Math.abs(pe.end - pe.start);
            cx = pe.topPos !== undefined ? pe.topPos : 0;
            cw = (pe.bottomPos !== undefined ? pe.bottomPos : img.width) - cx;
        }
        cx = Math.max(0, Math.round(cx));
        cy = Math.max(0, Math.round(cy));
        cw = Math.min(Math.round(cw), img.width - cx);
        ch = Math.min(Math.round(ch), img.height - cy);
        if (cw < 3 || ch < 3) return null;
        const lineCanvas = document.createElement('canvas');
        lineCanvas.width = cw; lineCanvas.height = ch;
        lineCanvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
        return lineCanvas;
    }

    // Map cellIdx → (colIdx, charWithinCol)
    let idx = 0;
    for (let ci = 0; ci < columns.length; ci++) {
        const col = columns[ci];
        const pe = primaryEdges[ci];
        const allCuts = [0, ...col.cuts, col.endPos];
        for (let i = 0; i < allCuts.length - 1; i++) {
            if (allCuts[i + 1] <= allCuts[i]) continue;
            if (idx === cellIdx) {
                let cx, cy, cw, ch;
                if (primaryAxis === 'x') {
                    cx = regionOX + Math.min(pe.start, pe.end);
                    cw = Math.abs(pe.end - pe.start);
                    cy = regionOY + allCuts[i];
                    ch = allCuts[i + 1] - allCuts[i];
                } else {
                    cy = regionOY + Math.min(pe.start, pe.end);
                    ch = Math.abs(pe.end - pe.start);
                    cx = regionOX + allCuts[i];
                    cw = allCuts[i + 1] - allCuts[i];
                }
                cx = Math.max(0, Math.round(cx));
                cy = Math.max(0, Math.round(cy));
                cw = Math.min(Math.round(cw), img.width - cx);
                ch = Math.min(Math.round(ch), img.height - cy);
                if (cw < 3 || ch < 3) return null;

                // Draw full image onto temp canvas for pixel access
                if (!state._imgCanvas) {
                    const tc = document.createElement('canvas');
                    tc.width = img.width; tc.height = img.height;
                    tc.getContext('2d').drawImage(img, 0, 0);
                    state._imgCanvas = tc;
                    state._imgData = tc.getContext('2d').getImageData(0, 0, img.width, img.height).data;
                    state._isInk = getAdaptiveThreshold(state._imgData, img.width, img.height).isInk;
                }
                return trimCharacter(state._imgCanvas, cx, cy, cw, ch,
                    state._imgData, img.width, img.height, state._isInk);
            }
            idx++;
        }
    }
    return null;
}

function getCharCanvas(cellIdx, source) {
    // In pick mode with edit state available, extract from current cut positions
    const canvasId = source === 'orig' ? 'cutLinesCanvas1' : 'cutLinesCanvas2';
    const state = editStates[canvasId];
    if (state) {
        return extractCharFromEditState(state, cellIdx);
    }
    const chars = source === 'orig' ? lastChars1 : lastChars2;
    return chars[cellIdx] || null;
}

function pickRefreshComparison() {
    const counter = document.getElementById('pickCounter');
    const undoBtn = document.getElementById('pickUndoBtn');
    if (counter) {
        const origCount = pickList.filter(p => p.source === 'orig').length;
        const practCount = pickList.filter(p => p.source === 'practice').length;
        counter.textContent = `原稿 ${origCount} 字，临摹 ${practCount} 字`;
    }
    if (undoBtn) undoBtn.disabled = pickUndoStack.length === 0;

    // Build pairs and display
    const origPicks = pickList.filter(p => p.source === 'orig');
    const practPicks = pickList.filter(p => p.source === 'practice');
    const maxLen = Math.max(origPicks.length, practPicks.length);

    if (maxLen === 0) {
        comparisonGrid.innerHTML = '<div class="loading" style="color:#999">📌 双击上方分割预览中的字格，逐个添加到此处对比</div>';
        return;
    }

    const compareMode = compareModeSelect.value;
    const isLineMode = compareMode === 'line';

    lastPairs = [];
    if (isLineMode) {
        // Line mode: build line pairs
        lastLinePairs = [];
        for (let i = 0; i < maxLen; i++) {
            const origLine = origPicks[i] ? getCharCanvas(origPicks[i].cellIdx, 'orig') : null;
            const practLine = practPicks[i] ? getCharCanvas(practPicks[i].cellIdx, 'practice') : null;
            lastLinePairs.push({ orig: origLine, practice: practLine });
        }
        const resultsTitle = document.getElementById('resultsTitle');
        resultsTitle.textContent = '整列/行对比结果（手动选字）';
        displayLineComparison(lastLinePairs, origPicks.length, practPicks.length);
    } else {
        // Character mode: build char pairs
        for (let i = 0; i < maxLen; i++) {
            const origChar = origPicks[i] ? getCharCanvas(origPicks[i].cellIdx, 'orig') : null;
            const practChar = practPicks[i] ? getCharCanvas(practPicks[i].cellIdx, 'practice') : null;
            lastPairs.push({
                orig: origChar, practice: practChar, score: null,
                _origPick: origPicks[i] || null,
                _practPick: practPicks[i] || null
            });
        }
        const resultsTitle = document.getElementById('resultsTitle');
        resultsTitle.textContent = '单字对比结果（手动选字）';
        displayCharComparison(lastPairs, origPicks.length, practPicks.length, false);
    }
    document.getElementById('downloadBtn').disabled = maxLen === 0;
}

function updatePickHighlights() {
    // Update preview highlights based on pick list
    for (const canvasId of ['cutLinesCanvas1', 'cutLinesCanvas2']) {
        const state = editStates[canvasId];
        if (!state) continue;
        const source = canvasId === 'cutLinesCanvas1' ? 'orig' : 'practice';
        state.selectedCells.clear();
        for (const p of pickList) {
            if (p.source === source) state.selectedCells.add(p.cellIdx);
        }
        drawEditablePreview(state);
    }
}

function onEditMouseDown(state, e) {
    const { x, y } = getCanvasCoords(state, e);
    const hit = findNearestLine(state, x, y);
    if (hit) {
        state.dragging = hit;
        state.selected = hit;
        state.dragOrigin = { x, y };
        state.dragStartPos = getLinePos(state, hit);
        state.canvas.style.cursor = getCursorForHit(state, hit);
        state.canvas.focus();
        drawEditablePreview(state);
        e.preventDefault();
    } else {
        // In pick mode, single-click does nothing on cells (dblclick handles it)
        if (pickModeActive) {
            state.selected = null;
            drawEditablePreview(state);
        } else {
            // Check if clicked inside a cell → toggle selection
            const cellIdx = findCell(state, x, y);
            if (cellIdx >= 0) {
                if (state.selectedCells.has(cellIdx)) {
                    state.selectedCells.delete(cellIdx);
                } else {
                    state.selectedCells.add(cellIdx);
                }
                syncSelectionToCheckboxes(state);
                drawEditablePreview(state);
                e.preventDefault();
            } else {
                state.selected = null;
                drawEditablePreview(state);
            }
        }
    }
}

function onEditMouseMove(state, e) {
    const { x, y } = getCanvasCoords(state, e);

    if (state.dragging) {
        const hit = state.dragging;
        const minGap = 5;

        // Delta-based: compute movement from drag origin, apply to start position
        const dx = x - state.dragOrigin.x;
        const dy = y - state.dragOrigin.y;

        if (hit.type === 'primary') {
            const delta = state.primaryAxis === 'x' ? dx : dy;
            movePrimaryEdge(state, hit.segIdx, hit.edge, state.dragStartPos + delta);
        } else if (hit.type === 'secondary') {
            const col = state.columns[hit.colIdx];
            const cutIdx = hit.cutIdx;
            const delta = col.secAxis === 'y' ? dy : dx;
            const newPos = state.dragStartPos + delta;
            const lo = cutIdx > 0 ? col.cuts[cutIdx - 1] + minGap : minGap;
            const hi = cutIdx < col.cuts.length - 1 ? col.cuts[cutIdx + 1] - minGap : col.endPos - minGap;
            col.cuts[cutIdx] = Math.max(lo, Math.min(hi, Math.round(newPos)));
        } else if (hit.type === 'end') {
            const col = state.columns[hit.colIdx];
            const delta = col.secAxis === 'y' ? dy : dx;
            const newPos = state.dragStartPos + delta;
            const lo = col.cuts.length > 0 ? col.cuts[col.cuts.length - 1] + minGap : minGap;
            col.endPos = Math.max(lo, Math.min(col.secLen, Math.round(newPos)));
        } else if (hit.type === 'lineTop') {
            const delta = state.primaryAxis === 'x' ? dy : dx;
            const pe = state.primaryEdges[hit.segIdx];
            const newPos = state.dragStartPos + delta;
            pe.topPos = Math.max(0, Math.min(pe.bottomPos - minGap, Math.round(newPos)));
        } else if (hit.type === 'lineBottom') {
            const delta = state.primaryAxis === 'x' ? dy : dx;
            const pe = state.primaryEdges[hit.segIdx];
            const newPos = state.dragStartPos + delta;
            pe.bottomPos = Math.max(pe.topPos + minGap, Math.min(state.secDimLen, Math.round(newPos)));
        }

        state.modified = true;
        drawEditablePreview(state);
        updateManualButtons();
        e.preventDefault();
    } else {
        const hit = findNearestLine(state, x, y);
        if (hit) {
            state.canvas.style.cursor = getCursorForHit(state, hit);
            state.hovered = hit;
        } else {
            const cellIdx = findCell(state, x, y);
            state.canvas.style.cursor = cellIdx >= 0 ? 'pointer' : 'default';
            if (state.hovered) {
                state.hovered = null;
                drawEditablePreview(state);
            }
        }
    }
}

function onEditMouseUp(state, e) {
    if (state.dragging) {
        state.dragging = null;
        state.canvas.style.cursor = 'default';
        drawEditablePreview(state);
    }
}

function onEditDblClick(state, e) {
    if (!pickModeActive) return;
    const { x, y } = getCanvasCoords(state, e);
    const cellIdx = findCell(state, x, y);
    if (cellIdx < 0) return;
    const source = state.canvas.id === 'cutLinesCanvas1' ? 'orig' : 'practice';
    pickAddChar(cellIdx, source);
    e.preventDefault();
}

// Progressive keyboard acceleration state
let keyRepeatCount = 0;
let keyRepeatKey = '';
let keyRepeatTimer = null;

function getProgressiveStep(key) {
    if (key !== keyRepeatKey) {
        keyRepeatCount = 0;
        keyRepeatKey = key;
    }
    keyRepeatCount++;
    clearTimeout(keyRepeatTimer);
    keyRepeatTimer = setTimeout(() => { keyRepeatCount = 0; keyRepeatKey = ''; }, 300);

    // 1→1→1→1→2→2→2→3→3→5→5→8... (ramp up over ~1s of holding)
    if (keyRepeatCount <= 4) return 1;
    if (keyRepeatCount <= 7) return 2;
    if (keyRepeatCount <= 10) return 3;
    if (keyRepeatCount <= 15) return 5;
    return 8;
}

function onEditKeyDown(state, e) {
    if (!state.selected) return;

    const key = e.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;

    e.preventDefault();
    const step = getProgressiveStep(key);
    const hit = state.selected;
    const minGap = 5;

    // Determine delta along the line's movement axis
    let delta = 0;
    if (hit.type === 'primary') {
        // Primary lines move along primary axis (x for vertical, y for horizontal)
        if (state.primaryAxis === 'x') {
            if (key === 'ArrowLeft') delta = -step;
            else if (key === 'ArrowRight') delta = step;
            else return;
        } else {
            if (key === 'ArrowUp') delta = -step;
            else if (key === 'ArrowDown') delta = step;
            else return;
        }

        const pe = state.primaryEdges[hit.segIdx];
        movePrimaryEdge(state, hit.segIdx, hit.edge, pe[hit.edge] + delta);
    } else if (hit.type === 'lineTop' || hit.type === 'lineBottom') {
        // Top/bottom lines move along secondary axis
        if (state.primaryAxis === 'x') {
            if (key === 'ArrowUp') delta = -step;
            else if (key === 'ArrowDown') delta = step;
            else return;
        } else {
            if (key === 'ArrowLeft') delta = -step;
            else if (key === 'ArrowRight') delta = step;
            else return;
        }
        const pe = state.primaryEdges[hit.segIdx];
        if (hit.type === 'lineTop') {
            pe.topPos = Math.max(0, Math.min(pe.bottomPos - minGap, pe.topPos + delta));
        } else {
            pe.bottomPos = Math.max(pe.topPos + minGap, Math.min(state.secDimLen, pe.bottomPos + delta));
        }
    } else {
        // Secondary / end lines move along secondary axis
        const col = state.columns[hit.colIdx];
        if (col.secAxis === 'y') {
            if (key === 'ArrowUp') delta = -step;
            else if (key === 'ArrowDown') delta = step;
            else return;
        } else {
            if (key === 'ArrowLeft') delta = -step;
            else if (key === 'ArrowRight') delta = step;
            else return;
        }

        if (hit.type === 'secondary') {
            const cutIdx = hit.cutIdx;
            const lo = cutIdx > 0 ? col.cuts[cutIdx - 1] + minGap : minGap;
            const hi = cutIdx < col.cuts.length - 1 ? col.cuts[cutIdx + 1] - minGap : col.endPos - minGap;
            col.cuts[cutIdx] = Math.max(lo, Math.min(hi, col.cuts[cutIdx] + delta));
        } else if (hit.type === 'end') {
            const lo = col.cuts.length > 0 ? col.cuts[col.cuts.length - 1] + minGap : minGap;
            col.endPos = Math.max(lo, Math.min(col.secLen, col.endPos + delta));
        }
    }

    state.modified = true;
    drawEditablePreview(state);
    updateManualButtons();
}

function isLineActive(state, type, idx, extra) {
    for (const src of [state.dragging, state.hovered, state.selected]) {
        if (!src || src.type !== type) continue;
        if (type === 'primary' && src.segIdx === idx && src.edge === extra) return true;
        if (type === 'end' && src.colIdx === idx) return true;
        if (type === 'secondary' && src.colIdx === idx && src.cutIdx === extra) return true;
        if (type === 'lineTop' && src.segIdx === idx) return true;
        if (type === 'lineBottom' && src.segIdx === idx) return true;
    }
    return false;
}

function drawEditablePreview(state) {
    const { ctx, canvas, img, regionOX, regionOY, primaryAxis, primaryEdges, columns } = state;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const lw = Math.max(2, Math.round(Math.max(img.width, img.height) / 500));

    // Draw primary edges (column/row boundaries) — draggable red lines
    for (let si = 0; si < primaryEdges.length; si++) {
        const pe = primaryEdges[si];
        for (const edge of ['start', 'end']) {
            const pos = pe[edge];
            const active = isLineActive(state, 'primary', si, edge);
            const origKey = edge === 'start' ? 'origStart' : 'origEnd';
            const modified = pos !== pe[origKey];

            ctx.strokeStyle = active ? 'rgba(255, 255, 0, 0.9)' :
                modified ? 'rgba(255, 165, 0, 0.8)' : 'rgba(0, 180, 60, 0.7)';
            ctx.lineWidth = active ? lw + 2 : lw;
            ctx.setLineDash([]);

            if (primaryAxis === 'x') {
                const x = regionOX + pos;
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, img.height); ctx.stroke();
            } else {
                const y = regionOY + pos;
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(img.width, y); ctx.stroke();
            }
        }
    }

    // Draw secondary cuts + end terminators + numbering
    const fontSize = Math.max(14, Math.round(img.width / 60));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let charIdx = 0;

    for (let ci = 0; ci < columns.length; ci++) {
        const col = columns[ci];
        const { lineSeg, cuts, secAxis, endPos, origEndPos } = col;

        // Secondary cut lines (blue)
        for (let i = 0; i < cuts.length; i++) {
            const active = isLineActive(state, 'secondary', ci, i);
            const modified = cuts[i] !== col.origCuts[i];

            ctx.strokeStyle = active ? 'rgba(255, 255, 0, 0.9)' :
                modified ? 'rgba(255, 165, 0, 0.8)' : 'rgba(0, 160, 80, 0.6)';
            ctx.lineWidth = active ? lw + 2 : Math.max(1, lw - 1);
            ctx.setLineDash([]);

            if (secAxis === 'y') {
                const y = regionOY + cuts[i];
                ctx.beginPath(); ctx.moveTo(regionOX + lineSeg.start, y); ctx.lineTo(regionOX + lineSeg.end, y); ctx.stroke();
            } else {
                const x = regionOX + cuts[i];
                ctx.beginPath(); ctx.moveTo(x, regionOY + lineSeg.start); ctx.lineTo(x, regionOY + lineSeg.end); ctx.stroke();
            }
        }

        // End terminator (dashed purple line)
        const endActive = isLineActive(state, 'end', ci);
        const endModified = endPos !== origEndPos;

        ctx.strokeStyle = endActive ? 'rgba(255, 255, 0, 0.9)' :
            endModified ? 'rgba(255, 165, 0, 0.8)' : 'rgba(0, 140, 100, 0.6)';
        ctx.lineWidth = endActive ? lw + 2 : Math.max(1, lw - 1);
        ctx.setLineDash([8, 5]);

        if (secAxis === 'y') {
            const y = regionOY + endPos;
            ctx.beginPath(); ctx.moveTo(regionOX + lineSeg.start, y); ctx.lineTo(regionOX + lineSeg.end, y); ctx.stroke();
        } else {
            const x = regionOX + endPos;
            ctx.beginPath(); ctx.moveTo(x, regionOY + lineSeg.start); ctx.lineTo(x, regionOY + lineSeg.end); ctx.stroke();
        }
        ctx.setLineDash([]);

        // Highlight selected cells + number each cell
        const allCuts = [0, ...cuts, endPos];
        for (let i = 0; i < allCuts.length - 1; i++) {
            if (allCuts[i + 1] <= allCuts[i]) continue;
            const isSelected = state.selectedCells.has(charIdx);

            // Draw highlight overlay for selected cells
            if (isSelected) {
                ctx.fillStyle = pickModeActive ? 'rgba(255, 160, 50, 0.3)' : 'rgba(100, 180, 255, 0.25)';
                if (secAxis === 'y') {
                    ctx.fillRect(regionOX + lineSeg.start, regionOY + allCuts[i],
                        lineSeg.end - lineSeg.start, allCuts[i + 1] - allCuts[i]);
                } else {
                    ctx.fillRect(regionOX + allCuts[i], regionOY + lineSeg.start,
                        allCuts[i + 1] - allCuts[i], lineSeg.end - lineSeg.start);
                }
            }

            // Cell number
            ctx.fillStyle = isSelected ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 50, 50, 0.85)';
            let tx, ty;
            if (secAxis === 'y') {
                tx = regionOX + (lineSeg.start + lineSeg.end) / 2;
                ty = regionOY + allCuts[i] + 3;
            } else {
                tx = regionOX + allCuts[i] + 3;
                ty = regionOY + (lineSeg.start + lineSeg.end) / 2;
            }
            ctx.fillText(String(charIdx + 1), tx, ty);

            // In pick mode, show pick order number
            if (pickModeActive && isSelected) {
                const source = state.canvas.id === 'cutLinesCanvas1' ? 'orig' : 'practice';
                const pickIdx = pickList.findIndex(p => p.cellIdx === charIdx && p.source === source);
                if (pickIdx >= 0) {
                    const orderStr = `[${pickIdx + 1}]`;
                    ctx.fillStyle = 'rgba(255, 100, 0, 0.95)';
                    const smallFont = Math.max(11, Math.round(fontSize * 0.75));
                    ctx.font = `bold ${smallFont}px sans-serif`;
                    if (secAxis === 'y') {
                        ctx.fillText(orderStr, tx, ty + fontSize + 2);
                    } else {
                        ctx.fillText(orderStr, tx, ty + fontSize + 2);
                    }
                    ctx.font = `bold ${fontSize}px sans-serif`;
                }
            }

            charIdx++;
        }
    }

    // Line mode: number primary segments when no secondary cuts exist
    if (columns.length === 0 && primaryEdges.length > 0) {
        const fontSize2 = Math.max(16, Math.round(img.width / 40));
        ctx.font = `bold ${fontSize2}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let si = 0; si < primaryEdges.length; si++) {
            const pe = primaryEdges[si];
            const isSelected = state.selectedCells.has(si);

            let x1, y1, x2, y2, cx, cy;
            if (primaryAxis === 'x') {
                x1 = regionOX + Math.min(pe.start, pe.end);
                x2 = regionOX + Math.max(pe.start, pe.end);
                y1 = pe.topPos !== undefined ? pe.topPos : 0;
                y2 = pe.bottomPos !== undefined ? pe.bottomPos : img.height;
                cx = (x1 + x2) / 2; cy = (y1 + y2) / 2;
            } else {
                y1 = regionOY + Math.min(pe.start, pe.end);
                y2 = regionOY + Math.max(pe.start, pe.end);
                x1 = pe.topPos !== undefined ? pe.topPos : 0;
                x2 = pe.bottomPos !== undefined ? pe.bottomPos : img.width;
                cx = (x1 + x2) / 2; cy = (y1 + y2) / 2;
            }

            if (isSelected) {
                ctx.fillStyle = pickModeActive ? 'rgba(255, 160, 50, 0.3)' : 'rgba(100, 180, 255, 0.2)';
                ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
            }

            ctx.fillStyle = isSelected ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 50, 50, 0.85)';
            ctx.fillText(String(si + 1), cx, cy);

            // In pick mode, show pick order
            if (pickModeActive && isSelected) {
                const source = state.canvas.id === 'cutLinesCanvas1' ? 'orig' : 'practice';
                const pickIdx = pickList.findIndex(p => p.cellIdx === si && p.source === source);
                if (pickIdx >= 0) {
                    ctx.fillStyle = 'rgba(255, 100, 0, 0.95)';
                    const smallFont = Math.max(11, Math.round(fontSize2 * 0.75));
                    ctx.font = `bold ${smallFont}px sans-serif`;
                    ctx.fillText(`[${pickIdx + 1}]`, cx, cy + fontSize2 + 4);
                    ctx.font = `bold ${fontSize2}px sans-serif`;
                }
            }

            // Draw top/bottom divider lines for height adjustment
            if (pe.topPos !== undefined) {
                for (const boundType of ['top', 'bottom']) {
                    const pos = boundType === 'top' ? pe.topPos : pe.bottomPos;
                    const origPos = boundType === 'top' ? pe.origTopPos : pe.origBottomPos;
                    const hitType = boundType === 'top' ? 'lineTop' : 'lineBottom';
                    const active = isLineActive(state, hitType, si);
                    const modified = pos !== origPos;

                    ctx.strokeStyle = active ? 'rgba(255, 255, 0, 0.9)' :
                        modified ? 'rgba(255, 165, 0, 0.8)' : 'rgba(0, 140, 180, 0.7)';
                    ctx.lineWidth = active ? lw + 2 : lw;
                    ctx.setLineDash([6, 4]);

                    if (primaryAxis === 'x') {
                        ctx.beginPath();
                        ctx.moveTo(regionOX + Math.min(pe.start, pe.end), pos);
                        ctx.lineTo(regionOX + Math.max(pe.start, pe.end), pos);
                        ctx.stroke();
                    } else {
                        ctx.beginPath();
                        ctx.moveTo(pos, regionOY + Math.min(pe.start, pe.end));
                        ctx.lineTo(pos, regionOY + Math.max(pe.start, pe.end));
                        ctx.stroke();
                    }
                    ctx.setLineDash([]);
                }
            }
        }
    }
}

function updateManualButtons() {
    const s1 = editStates['cutLinesCanvas1'];
    const s2 = editStates['cutLinesCanvas2'];
    const anyModified = (s1 && s1.modified) || (s2 && s2.modified);

    document.getElementById('applyManualBtn').style.display = anyModified ? '' : 'none';
    document.getElementById('resetCutsBtn').style.display = anyModified ? '' : 'none';
    document.getElementById('showCutDataBtn').style.display = anyModified ? '' : 'none';
}

function showCutLinePreview(img1, debug1, img2, debug2) {
    const preview = document.getElementById('segmentationPreview');
    const c1 = document.getElementById('cutLinesCanvas1');
    const c2 = document.getElementById('cutLinesCanvas2');

    if (debug1) {
        c1.width = img1.width;
        c1.height = img1.height;
        setupInteractiveCutLines(c1, img1, debug1);
    }
    if (debug2) {
        c2.width = img2.width;
        c2.height = img2.height;
        setupInteractiveCutLines(c2, img2, debug2);
    }

    document.getElementById('applyManualBtn').style.display = 'none';
    document.getElementById('resetCutsBtn').style.display = 'none';
    document.getElementById('showCutDataBtn').style.display = 'none';
    document.getElementById('cutDataOutput').style.display = 'none';

    preview.style.display = (debug1 || debug2) ? '' : 'none';
}

function resetCutLines() {
    for (const key of Object.keys(editStates)) {
        const state = editStates[key];
        if (!state) continue;
        for (let i = 0; i < state.primaryEdges.length; i++) {
            const pe = state.primaryEdges[i];
            pe.start = pe.origStart;
            pe.end = pe.origEnd;
            if (pe.origTopPos !== undefined) {
                pe.topPos = pe.origTopPos;
                pe.bottomPos = pe.origBottomPos;
            }
            if (i < state.columns.length) {
                state.columns[i].lineSeg = { start: pe.origStart, end: pe.origEnd };
            }
        }
        for (const col of state.columns) {
            col.cuts = [...col.origCuts];
            col.endPos = col.origEndPos;
        }
        state.modified = false;
        drawEditablePreview(state);
    }
    updateManualButtons();
    document.getElementById('cutDataOutput').style.display = 'none';
}

function toggleCutData() {
    const output = document.getElementById('cutDataOutput');
    const textarea = document.getElementById('cutDataText');

    if (output.style.display === 'none') {
        const lines = [];
        for (const [canvasId, label] of [['cutLinesCanvas1', '字帖原稿'], ['cutLinesCanvas2', '临摹作品']]) {
            const state = editStates[canvasId];
            if (!state || !state.modified) continue;
            lines.push(`=== ${label} ===`);

            // Primary edge changes
            const pChanges = [];
            state.primaryEdges.forEach((pe, i) => {
                if (pe.start !== pe.origStart) pChanges.push(`列${i + 1}起: ${pe.origStart}→${pe.start} (${pe.start - pe.origStart > 0 ? '+' : ''}${pe.start - pe.origStart}px)`);
                if (pe.end !== pe.origEnd) pChanges.push(`列${i + 1}止: ${pe.origEnd}→${pe.end} (${pe.end - pe.origEnd > 0 ? '+' : ''}${pe.end - pe.origEnd}px)`);
            });
            if (pChanges.length > 0) {
                lines.push('列边界调整: ' + pChanges.join(', '));
            }

            // Top/bottom bound changes (line mode)
            if (state.columns.length === 0) {
                const tbChanges = [];
                state.primaryEdges.forEach((pe, i) => {
                    if (pe.topPos !== undefined && pe.topPos !== pe.origTopPos) {
                        const d = pe.topPos - pe.origTopPos;
                        tbChanges.push(`列${i + 1}顶: ${pe.origTopPos}→${pe.topPos} (${d > 0 ? '+' : ''}${d}px)`);
                    }
                    if (pe.bottomPos !== undefined && pe.bottomPos !== pe.origBottomPos) {
                        const d = pe.bottomPos - pe.origBottomPos;
                        tbChanges.push(`列${i + 1}底: ${pe.origBottomPos}→${pe.bottomPos} (${d > 0 ? '+' : ''}${d}px)`);
                    }
                });
                if (tbChanges.length > 0) {
                    lines.push('高度调整: ' + tbChanges.join(', '));
                }
            }

            // Secondary cut + end changes per column
            for (let i = 0; i < state.columns.length; i++) {
                const col = state.columns[i];
                const hasCutChanges = col.cuts.some((c, j) => c !== col.origCuts[j]);
                const hasEndChange = col.endPos !== col.origEndPos;
                if (!hasCutChanges && !hasEndChange) continue;

                lines.push(`列${i + 1} (${col.cuts.length + 1}字):`);
                if (hasCutChanges) {
                    const origFrac = col.origCuts.map(c => (c / col.secLen).toFixed(4));
                    const newFrac = col.cuts.map(c => (c / col.secLen).toFixed(4));
                    const diffs = col.cuts.map((c, j) => {
                        const d = c - col.origCuts[j];
                        return d === 0 ? '  0' : (d > 0 ? '+' + d : '' + d);
                    });
                    lines.push(`  原始比例: [${origFrac.join(', ')}]`);
                    lines.push(`  调整比例: [${newFrac.join(', ')}]`);
                    lines.push(`  偏移像素: [${diffs.join(', ')}]`);
                }
                if (hasEndChange) {
                    lines.push(`  终止线: ${col.origEndPos}→${col.endPos} (${col.endPos - col.origEndPos > 0 ? '+' : ''}${col.endPos - col.origEndPos}px)`);
                }
            }
        }
        textarea.value = lines.length > 0 ? lines.join('\n') : '未做任何调整';
        output.style.display = '';
    } else {
        output.style.display = 'none';
    }
}

function applyManualAdjustments() {
    const dir1 = direction1Select.value;
    const dir2 = direction2Select.value;
    const lc1 = parseInt(lineCount1Input.value) || 0;
    const cpl1 = parseCharsPerLine(charsPerLine1Input.value);
    const lc2raw = parseInt(lineCount2Input.value) || 0;
    const cpl2raw = parseCharsPerLine(charsPerLine2Input.value);
    const lc2 = lc2raw || lc1;
    const cpl2 = cpl2raw.length > 0 ? cpl2raw : cpl1;
    const matchMode = matchModeSelect.value;
    const compareMode = compareModeSelect.value;

    const state1 = editStates['cutLinesCanvas1'];
    const state2 = editStates['cutLinesCanvas2'];

    function extractManual(state) {
        if (!state || !state.modified) return { primary: null, secondary: null };
        const primaryChanged = state.primaryEdges.some((pe) =>
            pe.start !== pe.origStart || pe.end !== pe.origEnd);
        const primary = primaryChanged
            ? state.primaryEdges.map(pe => ({ start: pe.start, end: pe.end }))
            : null;
        const secondary = state.columns.map(c => ({ cuts: [...c.cuts], endPos: c.endPos }));
        return { primary, secondary };
    }

    const m1 = extractManual(state1);
    const m2 = extractManual(state2);

    comparisonGrid.innerHTML = '<div class="loading">正在应用手动调整...</div>';

    setTimeout(() => {
        if (compareMode === 'line') {
            // Line mode: extract lines using edit state (respects top/bottom bounds)
            const extractLines = (state, img, dir, lc) => {
                if (state) {
                    const lines = [];
                    for (let i = 0; i < state.primaryEdges.length; i++) {
                        const canvas = extractCharFromEditState(state, i);
                        if (canvas) lines.push(canvas);
                    }
                    return lines;
                }
                return segmentLines(img, dir, lc, null).lines;
            };
            lastLines1 = extractLines(state1, image1Data, dir1, lc1);
            lastLines2 = extractLines(state2, image2Data, dir2, lc2);

            const maxLen = Math.max(lastLines1.length, lastLines2.length);
            lastLinePairs = [];
            for (let i = 0; i < maxLen; i++) {
                lastLinePairs.push({
                    orig: lastLines1[i] || null,
                    practice: lastLines2[i] || null
                });
            }
            resultsTitle.textContent = '整列/行对比结果（手动调整）';
            displayLineComparison(lastLinePairs, lastLines1.length, lastLines2.length);
        } else {
            // Character mode
            const origResult = segment2D(image1Data, dir1, lc1, cpl1, null, m1.secondary, m1.primary);
            lastChars1 = origResult.characters;

            const refFractions = m1.primary || m1.secondary ? null : origResult.cutFractions;
            const practResult = segment2D(image2Data, dir2, lc2, cpl2, refFractions, m2.secondary, m2.primary);
            lastChars2 = practResult.characters;

            if (matchMode === 'best' && lastChars1.length > 0 && lastChars2.length > 0) {
                const matches = findBestMatches(lastChars1, lastChars2);
                lastPairs = matches.map(m => ({
                    orig: lastChars1[m.origIdx],
                    practice: m.practIdx >= 0 ? lastChars2[m.practIdx] : null,
                    score: m.score
                }));
                resultsTitle.textContent = '单字对比结果（手动调整）';
                displayCharComparison(lastPairs, lastChars1.length, lastChars2.length, true);
            } else {
                const maxLen = Math.max(lastChars1.length, lastChars2.length);
                lastPairs = [];
                for (let i = 0; i < maxLen; i++) {
                    lastPairs.push({
                        orig: lastChars1[i] || null,
                        practice: lastChars2[i] || null,
                        score: null
                    });
                }
                resultsTitle.textContent = '单字对比结果（手动调整）';
                displayCharComparison(lastPairs, lastChars1.length, lastChars2.length, false);
            }
        }
        downloadBtn.disabled = false;
    }, 50);
}

// ============================================================
// Image similarity & best-match selection
// ============================================================

function normalizeCharImage(charCanvas, gridSize) {
    const norm = document.createElement('canvas');
    norm.width = gridSize;
    norm.height = gridSize;
    const ctx = norm.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, gridSize, gridSize);

    // Scale to fit with margin, maintain aspect ratio, center
    const margin = gridSize * 0.06;
    const available = gridSize - margin * 2;
    const scale = Math.min(available / charCanvas.width, available / charCanvas.height);
    const w = charCanvas.width * scale;
    const h = charCanvas.height * scale;
    ctx.drawImage(charCanvas, (gridSize - w) / 2, (gridSize - h) / 2, w, h);

    // Return ink-intensity array: 0 = background, 1 = full ink
    const data = ctx.getImageData(0, 0, gridSize, gridSize).data;
    const ink = new Float32Array(gridSize * gridSize);
    for (let i = 0; i < gridSize * gridSize; i++) {
        ink[i] = 1 - (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / (3 * 255);
    }
    return ink;
}

function computeSimilarity(canvas1, canvas2) {
    const G = 48;
    const g1 = normalizeCharImage(canvas1, G);
    const g2 = normalizeCharImage(canvas2, G);
    const n = G * G;

    // Pearson correlation on grayscale ink intensity
    let sum1 = 0, sum2 = 0;
    for (let i = 0; i < n; i++) { sum1 += g1[i]; sum2 += g2[i]; }
    const mean1 = sum1 / n, mean2 = sum2 / n;

    let cov = 0, var1 = 0, var2 = 0;
    for (let i = 0; i < n; i++) {
        const d1 = g1[i] - mean1, d2 = g2[i] - mean2;
        cov += d1 * d2;
        var1 += d1 * d1;
        var2 += d2 * d2;
    }
    const pearson = (var1 > 0 && var2 > 0) ? Math.max(0, cov / Math.sqrt(var1 * var2)) : 0;

    // IoU on binarized ink pixels
    const thresh = 0.25;
    let intersection = 0, union = 0;
    for (let i = 0; i < n; i++) {
        const ink1 = g1[i] > thresh;
        const ink2 = g2[i] > thresh;
        if (ink1 && ink2) intersection++;
        if (ink1 || ink2) union++;
    }
    const iou = union > 0 ? intersection / union : 0;

    // Aspect ratio penalty
    const ar1 = canvas1.width / canvas1.height;
    const ar2 = canvas2.width / canvas2.height;
    const arFactor = Math.min(ar1, ar2) / Math.max(ar1, ar2); // 0~1

    return (0.35 * pearson + 0.65 * iou) * (0.3 + 0.7 * arFactor);
}

function findBestMatches(origChars, practiceChars) {
    if (origChars.length === 0 || practiceChars.length === 0) return [];

    // Pre-compute normalized images for performance
    const G = 48;
    const origNorm = origChars.map(c => normalizeCharImage(c, G));
    const practNorm = practiceChars.map(c => normalizeCharImage(c, G));
    const n = G * G;
    const thresh = 0.25;

    // Compute all pairwise similarity scores
    const allScores = [];
    for (let r = 0; r < origChars.length; r++) {
        for (let p = 0; p < practiceChars.length; p++) {
            const g1 = origNorm[r], g2 = practNorm[p];

            let sum1 = 0, sum2 = 0;
            for (let i = 0; i < n; i++) { sum1 += g1[i]; sum2 += g2[i]; }
            const mean1 = sum1 / n, mean2 = sum2 / n;

            let cov = 0, v1 = 0, v2 = 0;
            let intersection = 0, union = 0;
            for (let i = 0; i < n; i++) {
                const d1 = g1[i] - mean1, d2 = g2[i] - mean2;
                cov += d1 * d2;
                v1 += d1 * d1;
                v2 += d2 * d2;
                const ink1 = g1[i] > thresh, ink2 = g2[i] > thresh;
                if (ink1 && ink2) intersection++;
                if (ink1 || ink2) union++;
            }
            const pearson = (v1 > 0 && v2 > 0) ? Math.max(0, cov / Math.sqrt(v1 * v2)) : 0;
            const iou = union > 0 ? intersection / union : 0;
            const ar1 = origChars[r].width / origChars[r].height;
            const ar2 = practiceChars[p].width / practiceChars[p].height;
            const arFactor = Math.min(ar1, ar2) / Math.max(ar1, ar2);
            const score = (0.35 * pearson + 0.65 * iou) * (0.3 + 0.7 * arFactor);

            allScores.push({ origIdx: r, practIdx: p, score });
        }
    }

    // Sort by score descending
    allScores.sort((a, b) => b.score - a.score);

    // Greedy assignment: each practice char used at most once
    const usedOrig = new Set();
    const usedPract = new Set();
    const result = new Array(origChars.length).fill(null);

    for (const entry of allScores) {
        if (usedOrig.has(entry.origIdx) || usedPract.has(entry.practIdx)) continue;
        result[entry.origIdx] = entry;
        usedOrig.add(entry.origIdx);
        usedPract.add(entry.practIdx);
        if (usedOrig.size === origChars.length) break;
    }

    // Fill unmatched originals
    for (let i = 0; i < origChars.length; i++) {
        if (!result[i]) result[i] = { origIdx: i, practIdx: -1, score: 0 };
    }

    return result;
}

/**
 * Parse chars-per-line input. Supports:
 *   "0" or "" → [] (auto-detect all)
 *   "9" → [9] (uniform, applied to all columns)
 *   "9,9,9,9,11,10" → [9,9,9,9,11,10] (per-column)
 */
function parseCharsPerLine(val) {
    const s = (val || '').trim();
    if (!s || s === '0') return [];
    const parts = s.split(/[,，]/).map(p => parseInt(p.trim())).filter(n => !isNaN(n) && n > 0);
    return parts;
}

// ============================================================
// Main action
// ============================================================

function segmentAndCompare() {
    const dir1 = direction1Select.value;
    const dir2 = direction2Select.value;
    const lc1 = parseInt(lineCount1Input.value) || 0;
    const cpl1 = parseCharsPerLine(charsPerLine1Input.value);

    // Practice inherits from original when left at default (same content structure)
    const lc2raw = parseInt(lineCount2Input.value) || 0;
    const cpl2raw = parseCharsPerLine(charsPerLine2Input.value);
    const lc2 = lc2raw || lc1;
    const cpl2 = cpl2raw.length > 0 ? cpl2raw : cpl1;

    const compareMode = compareModeSelect.value;
    const matchMode = matchModeSelect.value;

    segmentBtn.disabled = true;
    segmentBtn.textContent = '正在处理...';
    comparisonGrid.innerHTML = '<div class="loading">正在自动切割...</div>';
    resultsSection.classList.add('active');

    setTimeout(() => {
        if (compareMode === 'line') {
            // Line/column comparison mode — with cut line preview
            const origResult = segmentLines(image1Data, dir1, lc1);
            const practResult = segmentLines(image2Data, dir2, lc2);
            lastLines1 = origResult.lines;
            lastLines2 = practResult.lines;

            // Show interactive cut line preview
            showCutLinePreview(image1Data, origResult.debugInfo, image2Data, practResult.debugInfo);

            const maxLen = Math.max(lastLines1.length, lastLines2.length);
            lastLinePairs = [];
            for (let i = 0; i < maxLen; i++) {
                lastLinePairs.push({
                    orig: lastLines1[i] || null,
                    practice: lastLines2[i] || null
                });
            }
            resultsTitle.textContent = '整列/行对比结果';
            displayLineComparison(lastLinePairs, lastLines1.length, lastLines2.length);
            downloadBtn.disabled = false;
            segmentBtn.disabled = false;
            segmentBtn.textContent = '自动切割对比';
        } else {
            // Character comparison mode
            // Segment original first, then use its proportions to guide practice
            const origResult = segment2D(image1Data, dir1, lc1, cpl1);
            lastChars1 = origResult.characters;
            const practResult = segment2D(image2Data, dir2, lc2, cpl2, origResult.cutFractions);
            lastChars2 = practResult.characters;

            // Draw cut line previews
            showCutLinePreview(image1Data, origResult.debugInfo, image2Data, practResult.debugInfo);

            if (matchMode === 'best' && lastChars1.length > 0 && lastChars2.length > 0) {
                comparisonGrid.innerHTML = '<div class="loading">正在计算最佳匹配...</div>';
                setTimeout(() => {
                    const matches = findBestMatches(lastChars1, lastChars2);
                    lastPairs = matches.map(m => ({
                        orig: lastChars1[m.origIdx],
                        practice: m.practIdx >= 0 ? lastChars2[m.practIdx] : null,
                        score: m.score
                    }));
                    console.log('[match] Best matches:', matches.map(m =>
                        `orig${m.origIdx}→pract${m.practIdx} (${(m.score * 100).toFixed(1)}%)`
                    ));
                    resultsTitle.textContent = '单字对比结果';
                    displayCharComparison(lastPairs, lastChars1.length, lastChars2.length, true);
                    downloadBtn.disabled = false;
                    segmentBtn.disabled = false;
                    segmentBtn.textContent = '自动切割对比';
                }, 50);
            } else {
                const maxLen = Math.max(lastChars1.length, lastChars2.length);
                lastPairs = [];
                for (let i = 0; i < maxLen; i++) {
                    lastPairs.push({
                        orig: lastChars1[i] || null,
                        practice: lastChars2[i] || null,
                        score: null
                    });
                }
                resultsTitle.textContent = '单字对比结果';
                displayCharComparison(lastPairs, lastChars1.length, lastChars2.length, false);
                downloadBtn.disabled = false;
                segmentBtn.disabled = false;
                segmentBtn.textContent = '自动切割对比';
            }
        }
    }, 100);
}

// ============================================================
// Display: shared helpers
// ============================================================

function cloneCanvas(source) {
    if (!source) return null;
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d').drawImage(source, 0, 0);
    return c;
}

function cloneWithBox(canvas, color) {
    if (!canvas) return null;
    const c = cloneCanvas(canvas);
    const ctx = c.getContext('2d');
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, c.width - 2, c.height - 2);
    return c;
}

// ============================================================
// Display: line/column comparison
// ============================================================

function displayLineComparison(pairs, origCount, practCount) {
    comparisonGrid.innerHTML = '';

    if (pairs.length === 0) {
        if (pickModeActive) {
            comparisonGrid.innerHTML = '<div class="loading" style="color:#999">📌 双击上方分割预览中的列/行，逐个添加到此处对比</div>';
        } else {
            comparisonGrid.innerHTML = '<div class="loading">未检测到列/行，请调整参数后重试。</div>';
        }
        return;
    }

    const dirLabel1 = direction1Select.value === 'vertical' ? '列' : '行';
    const dirLabel2 = direction2Select.value === 'vertical' ? '列' : '行';

    if (!pickModeActive) {
        // Selection toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'selection-toolbar';
        toolbar.innerHTML = `
            <button onclick="document.querySelectorAll('.line-select-cb').forEach(c=>{c.checked=true;c.closest('.character-row').classList.remove('char-unselected')});updateLineSelectionCount()">全选</button>
            <button onclick="document.querySelectorAll('.line-select-cb').forEach(c=>{c.checked=false;c.closest('.character-row').classList.add('char-unselected')});updateLineSelectionCount()">全不选</button>
            <button onclick="document.querySelectorAll('.line-select-cb').forEach(c=>{c.checked=!c.checked;c.closest('.character-row').classList.toggle('char-unselected',!c.checked)});updateLineSelectionCount()">反选</button>
            <span class="selection-counter" id="lineSelectionCounter">已选 ${pairs.length}/${pairs.length}</span>
        `;
        comparisonGrid.appendChild(toolbar);
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'info-bar';
    infoDiv.innerHTML = `字帖 <strong>${origCount}</strong> ${dirLabel1}，临摹 <strong>${practCount}</strong> ${dirLabel2}`;
    if (origCount !== practCount) {
        infoDiv.innerHTML += ` <span class="warn">⚠️ 数量不一致，按顺序配对</span>`;
    }
    comparisonGrid.appendChild(infoDiv);

    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const row = document.createElement('div');
        row.className = 'character-row';

        // Header with checkbox/delete
        const header = document.createElement('div');
        header.className = 'char-header';

        if (pickModeActive) {
            const origPick = pair._origPick || (pickList.filter(p => p.source === 'orig')[i]);
            const practPick = pair._practPick || (pickList.filter(p => p.source === 'practice')[i]);
            const labelParts = [];
            if (origPick) labelParts.push(`原#${origPick.cellIdx + 1}`);
            if (practPick) labelParts.push(`临#${practPick.cellIdx + 1}`);
            const label = document.createElement('span');
            label.style.flex = '1';
            label.textContent = `第 ${i + 1} ${dirLabel1}（${labelParts.join(' vs ')}）`;
            header.appendChild(label);

            const delBtn = document.createElement('button');
            delBtn.className = 'pick-row-delete';
            delBtn.textContent = '🗑 删除';
            delBtn.onclick = () => {
                const origPicks = pickList.filter(p => p.source === 'orig');
                const practPicks = pickList.filter(p => p.source === 'practice');
                const oEntry = origPicks[i];
                const pEntry = practPicks[i];
                if (oEntry) { const idx = pickList.indexOf(oEntry); if (idx >= 0) pickList.splice(idx, 1); }
                if (pEntry) { const idx = pickList.indexOf(pEntry); if (idx >= 0) pickList.splice(idx, 1); }
                pickUndoStack.push({ action: 'removePair', origEntry: oEntry || null, practEntry: pEntry || null });
                updatePickHighlights();
                pickRefreshComparison();
            };
            header.appendChild(delBtn);
        } else {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'line-select-cb';
            cb.checked = true;
            cb.dataset.index = i;
            cb.onchange = () => {
                row.classList.toggle('char-unselected', !cb.checked);
                updateLineSelectionCount();
            };
            header.appendChild(cb);
            const label = document.createElement('span');
            label.textContent = `第 ${i + 1} ${dirLabel1}`;
            header.appendChild(label);
        }

        const combinedBox = document.createElement('div');
        combinedBox.className = 'combined-box';
        combinedBox.appendChild(header);

        const combinedDisplay = document.createElement('div');
        combinedDisplay.className = 'combined-display line-display';

        const leftClone = pair.orig ? cloneWithBox(pair.orig, '#e74c3c') : null;
        const rightClone = pair.practice ? cloneWithBox(pair.practice, '#27ae60') : null;
        const targetHeight = Math.max(leftClone?.height || 0, rightClone?.height || 0, 1);

        const addWrapped = (clone, kind) => {
            if (!clone) return;
            const scale = targetHeight / clone.height;
            const wrap = document.createElement('div');
            wrap.className = 'canvas-wrap';
            if (kind) wrap.classList.add(kind);
            wrap.dataset.w = clone.width;
            wrap.dataset.h = clone.height;
            wrap.dataset.scale = scale;
            wrap.style.width = `${clone.width * scale * currentZoom}px`;
            wrap.style.height = `${targetHeight * currentZoom}px`;
            clone.style.transform = `scale(${scale * currentZoom})`;
            wrap.appendChild(clone);
            combinedDisplay.appendChild(wrap);
        };

        addWrapped(leftClone, 'copybook');
        addWrapped(rightClone, 'practice');

        if (!leftClone && !rightClone) {
            combinedDisplay.innerHTML = '<span style="color:#999;">无对应内容</span>';
        }

        combinedBox.appendChild(combinedDisplay);
        row.appendChild(combinedBox);
        comparisonGrid.appendChild(row);
    }
}

function updateLineSelectionCount() {
    const all = document.querySelectorAll('.line-select-cb');
    const checked = document.querySelectorAll('.line-select-cb:checked');
    const counter = document.getElementById('lineSelectionCounter');
    if (counter) counter.textContent = `已选 ${checked.length}/${all.length}`;
}

// ============================================================
// Display: character comparison
// ============================================================

function updateSelectionCount() {
    const counter = document.getElementById('selectionCounter');
    if (!counter) return;
    const checkboxes = comparisonGrid.querySelectorAll('.char-select-cb');
    const checked = comparisonGrid.querySelectorAll('.char-select-cb:checked').length;
    counter.textContent = `已选 ${checked}/${checkboxes.length}`;
}

function displayCharComparison(pairs, origCount, practCount, isBestMatch) {
    comparisonGrid.innerHTML = '';

    if (pairs.length === 0) {
        comparisonGrid.innerHTML = '<div class="loading">未检测到字符，请调整参数后重试。</div>';
        return;
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'info-bar';
    if (pickModeActive) {
        infoDiv.innerHTML = `📌 手动选字：原稿 <strong>${origCount}</strong> 字，临摹 <strong>${practCount}</strong> 字`;
    } else if (isBestMatch) {
        infoDiv.innerHTML = `字帖 <strong>${origCount}</strong> 字，临摹 <strong>${practCount}</strong> 字 · 🎯 最佳匹配模式（从 ${practCount} 个候选中为每个原字选出最佳）`;
    } else {
        infoDiv.innerHTML = `字帖 <strong>${origCount}</strong> 字，临摹 <strong>${practCount}</strong> 字`;
        if (origCount !== practCount) {
            infoDiv.innerHTML += ` <span class="warn">⚠️ 字数不一致，按顺序配对</span>`;
        }
    }
    comparisonGrid.appendChild(infoDiv);

    // Selection toolbar (hidden in pick mode — controls are in the preview panel)
    if (!pickModeActive) {
        const toolbar = document.createElement('div');
        toolbar.className = 'selection-toolbar';
        toolbar.innerHTML = `
            <button type="button" onclick="document.querySelectorAll('.char-select-cb').forEach(c=>{c.checked=true;c.closest('.character-row').classList.remove('char-unselected')});syncCheckboxToPreview();updateSelectionCount()">☑ 全选</button>
            <button type="button" onclick="document.querySelectorAll('.char-select-cb').forEach(c=>{c.checked=false;c.closest('.character-row').classList.add('char-unselected')});syncCheckboxToPreview();updateSelectionCount()">☐ 全不选</button>
            <button type="button" onclick="document.querySelectorAll('.char-select-cb').forEach(c=>{c.checked=!c.checked;c.closest('.character-row').classList.toggle('char-unselected',!c.checked)});syncCheckboxToPreview();updateSelectionCount()">⇄ 反选</button>
            <span id="selectionCounter" class="selection-counter">已选 ${pairs.length}/${pairs.length}</span>
        `;
        comparisonGrid.appendChild(toolbar);
    }

    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const row = document.createElement('div');
        row.className = 'character-row';
        row.dataset.pairIndex = i;

        const combinedBox = document.createElement('div');
        combinedBox.className = 'combined-box';

        // Header: checkbox (normal) or delete button (pick mode)
        const header = document.createElement('div');
        header.className = 'char-header';

        if (pickModeActive) {
            // Pair-level delete button (remove entire row)
            const delBtn = document.createElement('button');
            delBtn.className = 'pick-row-delete';
            delBtn.innerHTML = '🗑 删除';
            delBtn.title = '移除此组';
            const pairIdx = i;
            delBtn.addEventListener('click', () => {
                const origPicks = pickList.filter(p => p.source === 'orig');
                const practPicks = pickList.filter(p => p.source === 'practice');
                const toRemove = [];
                if (origPicks[pairIdx]) toRemove.push(origPicks[pairIdx]);
                if (practPicks[pairIdx]) toRemove.push(practPicks[pairIdx]);
                for (const item of toRemove) {
                    const idx = pickList.indexOf(item);
                    if (idx >= 0) pickList.splice(idx, 1);
                }
                pickUndoStack.push({ action: 'removePair', items: toRemove, pairIdx });
                pickRefreshComparison();
                updatePickHighlights();
            });
            // Append delete button at the end (after h4 label)
            // We'll use a wrapper to push it to the right
            header.style.justifyContent = 'flex-start';
            header.style.flex = '1';

            // Build label first
            const origPicks2 = pickList.filter(p => p.source === 'orig');
            const practPicks2 = pickList.filter(p => p.source === 'practice');
            const origLabel = origPicks2[i] ? `原#${origPicks2[i].cellIdx + 1}` : '—';
            const practLabel = practPicks2[i] ? `临#${practPicks2[i].cellIdx + 1}` : '—';
            let headerHTML = `<h4 style="margin:0">第 ${i + 1} 组 <span style="font-size:0.8em;color:#888">(${origLabel} vs ${practLabel})</span></h4>`;
            const h4Wrap = document.createElement('span');
            h4Wrap.innerHTML = headerHTML;
            h4Wrap.style.flex = '1';
            header.appendChild(h4Wrap);
            header.appendChild(delBtn);
            combinedBox.appendChild(header);
        } else {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            cb.className = 'char-select-cb';
            cb.dataset.index = i;
            cb.addEventListener('change', () => {
                row.classList.toggle('char-unselected', !cb.checked);
                updateSelectionCount();
                syncCheckboxToPreview();
            });
            header.appendChild(cb);
        }

        // Build label text (non-pick mode only; pick mode builds it above)
        if (!pickModeActive) {
            let headerHTML = `<h4>第 ${i + 1} 组`;
            if (pair.score !== null) {
                const pct = (pair.score * 100).toFixed(0);
                const cls = pair.score >= 0.5 ? 'score-good' : pair.score >= 0.3 ? 'score-ok' : 'score-low';
                headerHTML += ` <span class="score-badge ${cls}">${pct}%</span>`;
            }
            headerHTML += `</h4>`;
            const h4Wrap = document.createElement('span');
            h4Wrap.innerHTML = headerHTML;
            header.appendChild(h4Wrap);
            combinedBox.appendChild(header);
        }

        const combinedDisplay = document.createElement('div');
        combinedDisplay.className = 'combined-display';

        const leftClone = pair.orig ? cloneWithBox(pair.orig, '#e74c3c') : null;
        const rightClone = pair.practice ? cloneWithBox(pair.practice, '#27ae60') : null;
        const targetHeight = Math.max(leftClone?.height || 0, rightClone?.height || 0, 1);

        const addCharWrapped = (clone, kind) => {
            if (!clone) return;
            const scale = targetHeight / clone.height;
            const wrap = document.createElement('div');
            wrap.className = 'canvas-wrap';
            if (kind) wrap.classList.add(kind);
            wrap.dataset.w = clone.width;
            wrap.dataset.h = clone.height;
            wrap.dataset.scale = scale;
            wrap.style.width = `${clone.width * scale * currentZoom}px`;
            wrap.style.height = `${targetHeight * currentZoom}px`;
            wrap.style.overflow = 'hidden';
            clone.style.transformOrigin = 'top left';
            clone.style.transform = `scale(${scale * currentZoom})`;
            clone.style.cursor = 'grab';
            wrap.appendChild(clone);
            combinedDisplay.appendChild(wrap);

            // Drag to reposition character within its cell
            let dragInfo = null;
            let offX = 0, offY = 0;
            wrap.addEventListener('mousedown', (ev) => {
                dragInfo = { sx: ev.clientX, sy: ev.clientY, ox: offX, oy: offY };
                clone.style.cursor = 'grabbing';
                ev.preventDefault();
            });
            const onMove = (ev) => {
                if (!dragInfo) return;
                offX = dragInfo.ox + (ev.clientX - dragInfo.sx) / currentZoom;
                offY = dragInfo.oy + (ev.clientY - dragInfo.sy) / currentZoom;
                clone.style.transform = `translate(${offX}px, ${offY}px) scale(${scale * currentZoom})`;
            };
            const onUp = () => {
                if (dragInfo) { dragInfo = null; clone.style.cursor = 'grab'; }
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };

        addCharWrapped(leftClone, 'copybook');
        addCharWrapped(rightClone, 'practice');

        if (!leftClone && !rightClone) {
            combinedDisplay.innerHTML = '<span style="color:#999;">无对应内容</span>';
        }

        combinedBox.appendChild(combinedDisplay);
        row.appendChild(combinedBox);
        comparisonGrid.appendChild(row);
    }
}

// ============================================================
// Download composite comparison image
// ============================================================

function downloadComparison() {
    const compareMode = compareModeSelect.value;
    if (compareMode === 'line') {
        downloadLineComparison();
    } else {
        downloadCharComparison();
    }
}

function downloadLineComparison() {
    if (lastLinePairs.length === 0) return;

    // Determine selected pairs
    let selectedPairs;
    if (pickModeActive) {
        selectedPairs = lastLinePairs.map((pair, idx) => ({ pair, origIndex: idx }));
    } else {
        const checkboxes = comparisonGrid.querySelectorAll('.line-select-cb:checked');
        const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));
        if (selectedIndices.length === 0) {
            alert('请至少选择一个列/行进行下载');
            return;
        }
        selectedPairs = selectedIndices.map(idx => ({ pair: lastLinePairs[idx], origIndex: idx }));
    }

    const compact = document.getElementById('downloadStyle').value === 'compact';
    if (compact) {
        downloadLineCompact(selectedPairs);
    } else {
        downloadLineDefault(selectedPairs);
    }
}

function downloadLineCompact(selectedPairs) {
    const pairs = selectedPairs.filter(sp => sp.pair.orig || sp.pair.practice).map(sp => sp.pair);
    if (pairs.length === 0) return;

    // Compute uniform target height and scaled widths
    const layouts = pairs.map(pair => {
        const l = pair.orig, r = pair.practice;
        const targetH = Math.max(l ? l.height : 0, r ? r.height : 0, 50);
        const lw = l ? Math.round(l.width * targetH / l.height) : 0;
        const rw = r ? Math.round(r.width * targetH / r.height) : 0;
        return { targetH, lw, rw };
    });

    const lineW = 2;
    const maxLW = Math.max(...layouts.map(l => l.lw), 1);
    const maxRW = Math.max(...layouts.map(l => l.rw), 1);
    const totalW = maxLW + lineW + maxRW;
    const totalH = layouts.reduce((s, l) => s + l.targetH, 0);

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, totalW, totalH);

    // Vertical divider
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(maxLW + lineW / 2, 0);
    ctx.lineTo(maxLW + lineW / 2, totalH);
    ctx.stroke();

    // Top horizontal line
    ctx.beginPath();
    ctx.moveTo(0, lineW / 2);
    ctx.lineTo(totalW, lineW / 2);
    ctx.stroke();

    let curY = 0;
    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const { targetH, lw, rw } = layouts[i];

        if (pair.orig) {
            const dx = maxLW - lw;
            ctx.drawImage(pair.orig, dx, curY, lw, targetH);
        }
        if (pair.practice) {
            ctx.drawImage(pair.practice, maxLW + lineW, curY, rw, targetH);
        }
        curY += targetH;
    }

    triggerDownload(canvas, '书法对比_整列_简洁.png');
}

function downloadLineDefault(selectedPairs) {
    if (selectedPairs.length === 0) return;

    const margin = 30;
    const titleH = 40;
    const gap = 20;
    const labelH = 24;
    const maxLineH = 500;

    // Compute per-pair dimensions
    const pairLayouts = selectedPairs.map((sp) => {
        const l = sp.pair.orig, r = sp.pair.practice;
        const lh = l ? l.height : 0;
        const rh = r ? r.height : 0;
        const targetH = Math.min(Math.max(lh, rh, 50), maxLineH);
        const lScale = l ? targetH / l.height : 1;
        const rScale = r ? targetH / r.height : 1;
        const lw = l ? l.width * lScale : 0;
        const rw = r ? r.width * rScale : 0;
        return { targetH, lw, rw, lScale, rScale, totalW: lw + gap + rw };
    });

    const maxPairW = Math.max(...pairLayouts.map(p => p.totalW));
    const totalW = margin * 2 + maxPairW;
    const totalH = margin * 2 + titleH + pairLayouts.reduce((sum, p) => sum + labelH + p.targetH + 16, 0) + 30;

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, totalW, totalH);

    ctx.fillStyle = '#333';
    ctx.font = 'bold 20px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('书法临摹整列对比', totalW / 2, margin + 24);

    let curY = margin + titleH + 8;
    for (let i = 0; i < selectedPairs.length; i++) {
        const pair = selectedPairs[i].pair;
        const origIdx = selectedPairs[i].origIndex;
        const layout = pairLayouts[i];

        ctx.fillStyle = '#666';
        ctx.font = '12px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`第${origIdx + 1}列/行`, totalW / 2, curY + 14);
        curY += labelH;

        const startX = margin + (maxPairW - layout.totalW) / 2;

        if (pair.orig) {
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 2;
            ctx.strokeRect(startX - 1, curY - 1, layout.lw + 2, layout.targetH + 2);
            ctx.drawImage(pair.orig, startX, curY, layout.lw, layout.targetH);
        }

        if (pair.practice) {
            const rx = startX + layout.lw + gap;
            ctx.strokeStyle = '#27ae60';
            ctx.lineWidth = 2;
            ctx.strokeRect(rx - 1, curY - 1, layout.rw + 2, layout.targetH + 2);
            ctx.drawImage(pair.practice, rx, curY, layout.rw, layout.targetH);
        }

        curY += layout.targetH + 16;
    }

    // Legend
    drawLegend(ctx, margin, totalH - margin + 5);

    triggerDownload(canvas, '书法对比_整列.png');
}

function downloadCharComparison() {
    if (lastPairs.length === 0) return;

    // In pick mode, download all pairs; in normal mode, use checkboxes
    let selectedPairs;
    if (pickModeActive) {
        selectedPairs = lastPairs.map((pair, idx) => ({ pair, origIndex: idx }));
    } else {
        const checkboxes = comparisonGrid.querySelectorAll('.char-select-cb:checked');
        const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));
        if (selectedIndices.length === 0) {
            alert('请至少选择一个字组进行下载');
            return;
        }
        selectedPairs = selectedIndices.map(idx => ({ pair: lastPairs[idx], origIndex: idx }));
    }

    const compact = document.getElementById('downloadStyle').value === 'compact';
    if (compact) {
        downloadCharCompact(selectedPairs);
    } else {
        downloadCharDefault(selectedPairs);
    }
}

function downloadCharCompact(selectedPairs) {
    const maxLen = selectedPairs.length;
    let maxW = 0, maxH = 0;
    for (const { pair } of selectedPairs) {
        if (pair.orig) { maxW = Math.max(maxW, pair.orig.width); maxH = Math.max(maxH, pair.orig.height); }
        if (pair.practice) { maxW = Math.max(maxW, pair.practice.width); maxH = Math.max(maxH, pair.practice.height); }
    }
    const cellSize = Math.max(maxW, maxH, 80);
    const lineW = 2;
    const totalW = cellSize * 2 + lineW;
    const totalH = cellSize * maxLen;

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, totalW, totalH);

    // Vertical center divider
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(cellSize + lineW / 2, 0);
    ctx.lineTo(cellSize + lineW / 2, totalH);
    ctx.stroke();

    // Horizontal top line
    ctx.beginPath();
    ctx.moveTo(0, lineW / 2);
    ctx.lineTo(totalW, lineW / 2);
    ctx.stroke();

    for (let i = 0; i < maxLen; i++) {
        const { pair } = selectedPairs[i];
        const y = i * cellSize;
        if (pair.orig) drawScaledChar(ctx, pair.orig, 0, y, cellSize);
        if (pair.practice) drawScaledChar(ctx, pair.practice, cellSize + lineW, y, cellSize);
    }

    triggerDownload(canvas, '书法对比_简洁.png');
}

function downloadCharDefault(selectedPairs) {
    const maxLen = selectedPairs.length;
    const cellSize = 180;
    const colGap = 16;
    const rowGap = 12;
    const margin = 30;
    const titleH = 40;
    const labelH = 22;
    const colHeaderH = 28;
    const legendH = 30;

    const totalW = margin * 2 + cellSize * 2 + colGap;
    const totalH = margin * 2 + titleH + colHeaderH + maxLen * (cellSize + labelH) + Math.max(0, maxLen - 1) * rowGap + legendH;

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, totalW, totalH);

    ctx.fillStyle = '#333';
    ctx.font = 'bold 20px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('书法临摹单字对比', totalW / 2, margin + 24);

    const headerY = margin + titleH + 18;
    ctx.font = 'bold 14px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#e74c3c';
    ctx.fillText('🔴 字帖原字', margin + cellSize / 2, headerY);
    ctx.fillStyle = '#27ae60';
    ctx.fillText('🟢 临摹作品', margin + cellSize + colGap + cellSize / 2, headerY);

    const startY = margin + titleH + colHeaderH;

    for (let i = 0; i < maxLen; i++) {
        const { pair, origIndex } = selectedPairs[i];
        const baseY = startY + i * (cellSize + labelH + rowGap);

        ctx.fillStyle = '#666';
        ctx.font = '12px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        let label = `第${origIndex + 1}字`;
        if (pair.score !== null) label += ` (${(pair.score * 100).toFixed(0)}%)`;
        ctx.fillText(label, totalW / 2, baseY + 14);

        const cellY = baseY + labelH;
        const leftX = margin;
        const rightX = margin + cellSize + colGap;

        ctx.strokeStyle = '#e74c3c';
        ctx.lineWidth = 2;
        ctx.strokeRect(leftX, cellY, cellSize, cellSize);
        ctx.fillStyle = '#fff';
        ctx.fillRect(leftX + 1, cellY + 1, cellSize - 2, cellSize - 2);
        if (pair.orig) drawScaledChar(ctx, pair.orig, leftX, cellY, cellSize);

        ctx.strokeStyle = '#27ae60';
        ctx.lineWidth = 2;
        ctx.strokeRect(rightX, cellY, cellSize, cellSize);
        ctx.fillStyle = '#fff';
        ctx.fillRect(rightX + 1, cellY + 1, cellSize - 2, cellSize - 2);
        if (pair.practice) drawScaledChar(ctx, pair.practice, rightX, cellY, cellSize);
    }

    drawLegend(ctx, margin, totalH - margin + 5);
    triggerDownload(canvas, '书法对比_单字.png');
}

function drawLegend(ctx, margin, y) {
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(margin, y - 10, 12, 12);
    ctx.fillStyle = '#666';
    ctx.fillText('字帖原字', margin + 16, y);
    ctx.fillStyle = '#27ae60';
    ctx.fillRect(margin + 90, y - 10, 12, 12);
    ctx.fillStyle = '#666';
    ctx.fillText('临摹作品', margin + 106, y);
}

function drawScaledChar(ctx, charCanvas, x, y, cellSize) {
    const pad = 8;
    const available = cellSize - pad * 2;
    const scale = Math.min(available / charCanvas.width, available / charCanvas.height);
    const w = charCanvas.width * scale;
    const h = charCanvas.height * scale;
    ctx.drawImage(charCanvas, x + (cellSize - w) / 2, y + (cellSize - h) / 2, w, h);
}

function triggerDownload(canvas, filename) {
    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
}

// ============================================================
// Clear
// ============================================================

function clearAll() {
    image1Data = null;
    image2Data = null;
    lastChars1 = [];
    lastChars2 = [];
    lastLines1 = [];
    lastLines2 = [];
    lastPairs = [];
    lastLinePairs = [];

    image1Input.value = '';
    image2Input.value = '';
    lineCount1Input.value = '6';
    lineCount2Input.value = '0';
    charsPerLine1Input.value = '9,9,9,9,11,10';
    charsPerLine2Input.value = '0';
    direction1Select.value = 'vertical';
    direction2Select.value = 'vertical';
    matchModeSelect.value = 'sequential';

    [canvas1, canvas2].forEach(c => {
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
        c.classList.remove('active');
    });

    comparisonGrid.innerHTML = '';
    resultsSection.classList.remove('active');
    segmentBtn.disabled = true;
    downloadBtn.disabled = true;
}
