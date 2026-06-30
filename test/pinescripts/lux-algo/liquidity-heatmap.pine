// This work is licensed under a Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0) https://creativecommons.org/licenses/by-nc-sa/4.0/
// © LuxAlgo

//@version=6
indicator("Liquidity Structure & Order Flow [LuxAlgo]", "LuxAlgo - Liquidity Structure & Order Flow", overlay = true, max_labels_count = 500, max_boxes_count = 500, max_lines_count = 500)

//---------------------------------------------------------------------------------------------------------------------}
// Constants
//---------------------------------------------------------------------------------------------------------------------{
color BULL_COLOR = #089981
color BEAR_COLOR = #f23645
color POC_COLOR  = #ff9800

string G1 = "Volume Profile Settings"
string G2 = "Visualization"
string G3 = "Dashboard"
string G4 = "Unusual Volume Bubbles"

// Table Constants
color DATA       = #DBDBDB
color HEADERS    = #808080
color BACKGROUND = #161616
color BORDERS    = #2E2E2E

string TOP_RIGHT    = 'Top Right'
string BOTTOM_RIGHT = 'Bottom Right'
string BOTTOM_LEFT  = 'Bottom Left'

string TINY   = 'Tiny'
string SMALL  = 'Small'
string NORMAL = 'Normal'

int BINS_COUNT = 150
//---------------------------------------------------------------------------------------------------------------------}
// Inputs
//---------------------------------------------------------------------------------------------------------------------{
lookbackInput     = input.int(300, "Lookback Period", minval = 50, group = G1)
weightedInput     = input.bool(false, "Weight Recent Volume", group = G1)
vaPercentInput    = input.float(70.0, "Value Area %", minval = 1, maxval = 100, step = 5, group = G1)
smoothingInput    = input.int(3, "Profile Smoothing", minval = 0, maxval = 10, group = G1)

showHeatmapInput  = input.bool(true, "Show Heatmap", group = G2)
heatmapTranspInput= input.int(40, "Heatmap Transparency", minval = 0, maxval = 100, group = G2)

// --- Volume Delta Panel Inputs ---
G_DELTA           = "Volume Delta Backdrop"
showPriceDeltaInput      = input.bool(true, "Show Volume Delta Panel", group = G_DELTA)
priceDeltaIntensityInput = input.int(50, "Delta Intensity", minval = 0, maxval = 100, group = G_DELTA)
priceDeltaWidthInput     = input.int(100, "Delta Panel Width", minval = 10, maxval = 300, group = G_DELTA)
deltaEmaLenInput         = input.int(5, "Delta Smoothing Length", minval = 1, group = G_DELTA)

showPocInput      = input.bool(true, "Show Point of Control (POC)", group = G2)
showVoidInput     = input.bool(true, "Highlight Widest Void", group = G2)
showVaInput       = input.bool(true, "Show Value Area (VAH/VAL)", group = G2)
curveResolutionInput = input.int(2, "Curve Resolution (Sampling)", minval = 1, maxval = 10, group = G2)
curvesOffsetInput = input.int(100, "Curves X-Offset (Future Bars)", minval = 20, group = G2)

bullColorInput    = input.color(BULL_COLOR, "Lower Depth Color", group = G2, inline = "c1")
bearColorInput    = input.color(BEAR_COLOR, "Upper Depth Color", group = G2, inline = "c1")

// --- Unusual Volume Bubbles ---
showBubblesInput  = input.bool(true, "Show Bubbles", group = G4)
volThresholdInput = input.float(2.0, "Sensitivity (Z-Score)", minval = 0.5, maxval = 10.0, step = 0.5, group = G4, tooltip = "Standard deviations above mean volume to trigger a bubble.")
bubbleMinSize     = input.string(size.tiny, "Min Bubble Size", options = [size.tiny, size.small, size.normal], group = G4, inline = "sz")
bubbleMaxSize     = input.string(size.large, "Max Bubble Size", options = [size.small, size.normal, size.large, size.huge], group = G4, inline = "sz")

showDashInput     = input.bool(true, "Show Dashboard", group = G3)
dashPosInput      = input.string(TOP_RIGHT, "Position", options = [TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT], group = G3)
dashSizeInput     = input.string(SMALL, "Size", options = [TINY, SMALL, NORMAL], group = G3)
//---------------------------------------------------------------------------------------------------------------------}
// Types & Variables
//---------------------------------------------------------------------------------------------------------------------{
var float[] rawBins = array.new_float(BINS_COUNT, 0.0)
var float[] smoothBins = array.new_float(BINS_COUNT, 0.0)
var box[] heatmapBoxes = array.new<box>()
var box[] deltaPanelBoxes = array.new<box>()
var line[] pocGlowLines = array.new<line>()
var label[] bubbleLabels = array.new<label>()
var line[] bubbleLines = array.new<line>()

var parsedDashPos = switch dashPosInput
    TOP_RIGHT    => position.top_right
    BOTTOM_RIGHT => position.bottom_right
    BOTTOM_LEFT  => position.bottom_left

var parsedDashSize = switch dashSizeInput
    TINY   => size.tiny
    SMALL  => size.small
    NORMAL => size.normal
//---------------------------------------------------------------------------------------------------------------------}
// Functions
//---------------------------------------------------------------------------------------------------------------------{
cell(table t, int col, int row, string txt, color c = #FFFFFF, string halign = text.align_right, color bg = na) => 
    t.cell(col, row, txt, text_color = c, text_size = parsedDashSize, text_halign = halign, bgcolor = bg)

divider(table t, int row, int lastCol) =>    
    t.merge_cells(0, row, lastCol, row)
    cell(t, 0, row, '━━━━━━━━━━━━━━━━━━', c = BORDERS, halign = text.align_center)

// --- Volume Delta Logic ---
getDeltaColor(float val, float maxMag, int intensity) =>
    float norm = maxMag > 0 ? math.abs(val) / maxMag : 0.0
    color base = val >= 0 ? BULL_COLOR : BEAR_COLOR
    int transp = 100 - int(norm * (intensity / 100.0) * 85)
    color.new(base, transp)

//---------------------------------------------------------------------------------------------------------------------}
// Calculations
//---------------------------------------------------------------------------------------------------------------------{
highs      = ta.highest(lookbackInput)
lows       = ta.lowest(lookbackInput)
priceRange = highs - lows
mid        = math.avg(highs, lows)
binStep    = priceRange / BINS_COUNT

// --- Unusual Volume Detection (Dynamic Baseline) ---
// Using a 200-period lookback for a more stable "Normal" volume mean across different assets
volMa      = ta.sma(volume, 200)
volStd     = ta.stdev(volume, 200)

// Safety Buffer for Historical Data
max_bars_back(volume, 500), max_bars_back(close, 500), max_bars_back(open, 500)
max_bars_back(low, 500), max_bars_back(high, 500), max_bars_back(volMa, 500), max_bars_back(volStd, 500)

// Continuous stream for EMA calculation
float rawBarDelta = close > open ? volume : close < open ? -volume : 0.0
float smoothDelta = ta.ema(rawBarDelta, deltaEmaLenInput)
max_bars_back(smoothDelta, 500)

if barstate.islast
    array.fill(rawBins, 0.0)
    array.fill(smoothBins, 0.0)
    
    float[] dProfile = array.new_float(BINS_COUNT, 0.0)
    float buyAgg = 0.0, sellAgg = 0.0

    // 1. Calculate Raw Profile & Delta Distribution
    for i = 0 to lookbackInput - 1
        float w = weightedInput ? (1.0 - (float(i) / lookbackInput)) : 1.0
        float p = close[i], v = nz(volume[i]) * w
        
        if close[i] > open[i] 
            buyAgg += v 
        else if close[i] < open[i] 
            sellAgg += v
            
        int bIdx = math.min(BINS_COUNT - 1, math.max(0, int((p - lows) / binStep)))
        array.set(rawBins, bIdx, array.get(rawBins, bIdx) + v)
        array.set(dProfile, bIdx, array.get(dProfile, bIdx) + smoothDelta[i])

    // 2. Smooth Liquidity Heatmap
    for k = 0 to BINS_COUNT - 1
        float sum = 0.0, wSum = 0.0
        for s = -smoothingInput to smoothingInput
            int idx = k + s
            if idx >= 0 and idx < BINS_COUNT
                float sw = 1.0 / (1.0 + math.abs(s))
                sum += array.get(rawBins, idx) * sw
                wSum += sw
        array.set(smoothBins, k, sum / wSum)

    float maxVol   = array.max(smoothBins)
    float totalVol = array.sum(rawBins)
    int   pocIdx   = array.indexof(smoothBins, maxVol)
    float pocPrice = lows + (binStep * pocIdx) + (binStep / 2)
    
    // 3. Widest Void Logic
    float vThres = maxVol * 0.15
    int lVoidStart = 0, lVoidEnd = 0, cVoidStart = -1, mVoidLen = 0
    for k = 0 to BINS_COUNT - 1
        if array.get(smoothBins, k) < vThres
            if cVoidStart == -1 
                cVoidStart := k
            int len = k - cVoidStart + 1
            if len > mVoidLen
                mVoidLen := len
                lVoidStart := cVoidStart
                lVoidEnd := k
        else
            cVoidStart := -1
    
    float voidTop = lows + (lVoidEnd + 1) * binStep, voidBot = lows + lVoidStart * binStep, voidMid = math.avg(voidTop, voidBot)

    // 4. Value Area
    float vaTarget = totalVol * (vaPercentInput / 100.0)
    float curVaVol = array.get(smoothBins, pocIdx)
    int upIdx = pocIdx, dnIdx = pocIdx
    while curVaVol < vaTarget and (upIdx < BINS_COUNT - 1 or dnIdx > 0)
        float uV = upIdx < BINS_COUNT - 1 ? array.get(smoothBins, upIdx + 1) : 0.0
        float dV = dnIdx > 0 ? array.get(smoothBins, dnIdx - 1) : 0.0
        if uV >= dV and upIdx < BINS_COUNT - 1
            upIdx += 1
            curVaVol += uV
        else if dnIdx > 0
            dnIdx -= 1
            curVaVol += dV
        else 
            break
    float vah = lows + (upIdx + 1) * binStep, val = lows + (dnIdx) * binStep

    float upperVolTotal = 0.0, lowerVolTotal = 0.0
    for k = 0 to BINS_COUNT - 1
        if (lows + k * binStep) >= mid 
            upperVolTotal += array.get(smoothBins, k) 
        else 
            lowerVolTotal += array.get(smoothBins, k)
    
    float upperPerc = (upperVolTotal / totalVol) * 100, lowerPerc = (lowerVolTotal / totalVol) * 100
    float deltaAgg  = buyAgg - sellAgg
    float skewRatio = upperVolTotal / math.max(0.1, lowerVolTotal)
    float distToPoc = (close - pocPrice) / close * 100
    float rangeLoc  = (close - lows) / math.max(0.0001, priceRange) * 100

    //---------------------------------------------------------------------------------------------------------------------}
    // Visuals
    //---------------------------------------------------------------------------------------------------------------------{
    // Cleanup
    for b in heatmapBoxes 
        box.delete(b)
    array.clear(heatmapBoxes)
    for b in deltaPanelBoxes 
        box.delete(b)
    array.clear(deltaPanelBoxes)
    for l in bubbleLabels
        label.delete(l)
    array.clear(bubbleLabels)
    for l in bubbleLines
        line.delete(l)
    array.clear(bubbleLines)

    // Calculate Polyline Offsets Early to avoid Overlap
    float maxCum = 0.0, tempCum = 0.0
    for k = 0 to BINS_COUNT - 1
        tempCum += array.get(smoothBins, k) / maxVol
        if k == int(BINS_COUNT/2) or k == BINS_COUNT - 1
            maxCum := math.max(maxCum, tempCum), tempCum := 0.0
    float scaleFactor = (curvesOffsetInput * 0.9) / math.max(0.1, maxCum)

    float[] curveX = array.new_float(BINS_COUNT, float(bar_index + curvesOffsetInput))
    int midBin = int(BINS_COUNT/2)
    // Upper Curve
    for k = midBin to BINS_COUNT - 1
        float localCum = 0.0
        for s = midBin to k 
            localCum += array.get(smoothBins, s) / maxVol
        array.set(curveX, k, bar_index + curvesOffsetInput - (localCum * scaleFactor))
    // Lower Curve
    for k = midBin - 1 to 0
        float localCum = 0.0
        for s = k to midBin - 1 
            localCum += array.get(smoothBins, s) / maxVol
        array.set(curveX, k, bar_index + curvesOffsetInput - (localCum * scaleFactor))

    // 5. Volume Delta Panel (LAYER 1: BACK)
    if showPriceDeltaInput
        float maxD = 0.0
        for dVal in dProfile 
            maxD := math.max(maxD, math.abs(dVal))
        for k = 0 to BINS_COUNT - 1
            float dVal = array.get(dProfile, k)
            float bBot = lows + (binStep * k), bTop = bBot + binStep
            
            // Only render delta if the bin is within the Value Area (VAL to VAH)
            if math.abs(dVal) > 0 and bBot >= val and bTop <= vah
                color dCol = getDeltaColor(dVal, maxD, priceDeltaIntensityInput)
                // Stop box at polyline edge
                int xLimit = int(array.get(curveX, k))
                if xLimit > bar_index
                    array.push(deltaPanelBoxes, box.new(bar_index, bTop, xLimit, bBot, na, bgcolor = dCol))

    // 6. Liquidity Heatmap (LAYER 2)
    if showHeatmapInput
        for k = 0 to BINS_COUNT - 1
            float norm = array.get(smoothBins, k) / maxVol
            if norm > 0.01
                float bBot = lows + (binStep * k), bTop = bBot + binStep
                int dyTr = int(heatmapTranspInput + (100 - heatmapTranspInput) * (1.0 - math.pow(norm, 0.7)))
                color bCl = (bBot + binStep/2) > mid ? bearColorInput : bullColorInput
                array.push(heatmapBoxes, box.new(bar_index - lookbackInput, bTop, bar_index, bBot, na, bgcolor = color.new(bCl, dyTr)))
        array.push(heatmapBoxes, box.new(bar_index - lookbackInput, highs, bar_index, lows, border_color = color.new(chart.fg_color, 70), border_style = line.style_dotted, bgcolor = na))

    // 6.1 Unusual Volume Bubbles (Smart Lane Anti-Overlap System)
    if showBubblesInput
        float bearBaseY = highs + (priceRange * 0.08)
        float bullBaseY = lows  - (priceRange * 0.08)
        float laneGap   = priceRange * 0.06 
        
        float[] bearLanesX = array.from(1e10, 1e10, 1e10) 
        float[] bullLanesX = array.from(1e10, 1e10, 1e10)

        for i = 0 to lookbackInput - 1
            float v  = nz(volume[i])
            float ma = nz(volMa[i])
            float sd = nz(volStd[i])
            
            // DYNAMIC CALCULATION: 
            // 1. Z-Score identifies statistical outliers (Unusual spikes).
            // 2. RVOL filter ensures the spike is at least 1.5x the average volume.
            // This dual-check prevents false positives in low-volatility assets (Forex/Quiet Stocks).
            float z    = sd > 0 ? (v - ma) / sd : 0.0
            float rvol = ma > 0 ? v / ma : 0.0
            
            if z >= volThresholdInput and rvol > 1.5
                bool isBull = close[i] > open[i]
                color base  = isBull ? bullColorInput : bearColorInput
                int x       = bar_index - i
                
                int clearance = z >= volThresholdInput + 5 ? 14 : z >= volThresholdInput + 3 ? 10 : 6
                
                // --- Smart Lane Selection ---
                int lane = 0
                float[] activeLanesX = isBull ? bullLanesX : bearLanesX
                
                // Find the first lane that has enough horizontal clearance
                bool foundLane = false
                for l = 0 to 2
                    if array.get(activeLanesX, l) - x >= clearance
                        lane := l
                        array.set(activeLanesX, l, float(x))
                        foundLane := true
                        break
                
                // If no lane is clear, use the one with the largest distance
                if not foundLane
                    lane := array.indexof(activeLanesX, array.max(activeLanesX))
                    array.set(activeLanesX, lane, float(x))

                float targetY = isBull ? bullBaseY - (lane * laneGap) : bearBaseY + (lane * laneGap)
                
                // --- Vertical Connector Line ---
                float startY = isBull ? low[i] : high[i]
                line l = line.new(x, startY, x, targetY, 
                     color = color.new(base, 75), 
                     style = line.style_dashed, 
                     width = 1)
                array.push(bubbleLines, l)

                // --- Bubble Rendering ---
                string bSize = z < volThresholdInput + 1 ? size.tiny : 
                               z < volThresholdInput + 3 ? size.small : 
                               z < volThresholdInput + 5 ? size.normal : 
                               z < volThresholdInput + 7 ? size.large : size.huge
                
                float normZ = math.min(1.0, (z - volThresholdInput) / 6.0)
                color bCol  = color.new(base, 20 + int((1.0 - normZ) * 60))
                string volTxt = z >= volThresholdInput + 3 ? str.tostring(nz(volume[i]), format.volume) : ""

                // Glow Layer
                if z >= volThresholdInput + 4
                    label glowLbl = label.new(x, targetY, "", 
                         color = color.new(base, 85), 
                         style = label.style_circle, 
                         size  = size.huge)
                    array.push(bubbleLabels, glowLbl)
                
                // Main Bubble
                label mainLbl = label.new(x, targetY, volTxt, 
                     color     = bCol, 
                     textcolor = color.white,
                     style     = volTxt != "" ? label.style_label_center : label.style_circle, 
                     size      = bSize)
                array.push(bubbleLabels, mainLbl)

    var label pocL = na, label.delete(pocL), var label voidL = na, label.delete(voidL)
    var box voidZ = na, box.delete(voidZ), var line vHL = na, line.delete(vHL), var line vLL = na, line.delete(vLL), var line mLL = na, line.delete(mLL)
    for l in pocGlowLines 
        line.delete(l)
    array.clear(pocGlowLines)

    int boxEnd = bar_index, drawEnd = bar_index + curvesOffsetInput
    if showPocInput
        array.push(pocGlowLines, line.new(bar_index-lookbackInput, pocPrice, boxEnd, pocPrice, color = color.new(POC_COLOR, 85), width = 10))
        array.push(pocGlowLines, line.new(bar_index-lookbackInput, pocPrice, boxEnd, pocPrice, color = color.new(POC_COLOR, 60), width = 4))
        array.push(pocGlowLines, line.new(bar_index-lookbackInput, pocPrice, boxEnd, pocPrice, color = POC_COLOR, width = 1))
        pocL := label.new(boxEnd + 2, pocPrice, "POC", color = POC_COLOR, style = label.style_label_left, textcolor = color.white, size = size.small)
    
    if showVoidInput
        voidZ := box.new(bar_index + 2, voidTop, bar_index + 6, voidBot, border_color = color.new(chart.fg_color, 70), bgcolor = color.new(chart.fg_color, 90))
        voidL := label.new(bar_index + 6, voidMid, "Void", color = color.new(chart.fg_color, 30), style = label.style_label_left, textcolor = chart.bg_color, size = size.small)
    
    if showVaInput
        vHL := line.new(boxEnd, vah, drawEnd, vah, color = bearColorInput, style = line.style_dotted)
        vLL := line.new(boxEnd, val, drawEnd, val, color = bullColorInput, style = line.style_dotted)
    mLL := line.new(boxEnd, mid, drawEnd, mid, color = color.new(chart.fg_color, 70), style = line.style_dotted)

    // 7. Cumulative Smooth Curves (LAYER 3: TOP)
    chart.point[] cpS_f = array.new<chart.point>(), chart.point[] cpB_f = array.new<chart.point>()
    chart.point[] cpS_l = array.new<chart.point>(), chart.point[] cpB_l = array.new<chart.point>()
    
    // Setup Upper Curve
    array.push(cpS_f, chart.point.from_index(bar_index + curvesOffsetInput, mid))
    for k = midBin to BINS_COUNT - 1 by curveResolutionInput
        chart.point p = chart.point.from_index(int(array.get(curveX, k)), lows + (binStep * k) + (binStep / 2))
        array.push(cpS_f, p)
        array.push(cpS_l, p)
    array.push(cpS_f, chart.point.from_index(bar_index + curvesOffsetInput, highs))

    // Setup Lower Curve
    array.push(cpB_f, chart.point.from_index(bar_index + curvesOffsetInput, mid))
    for i = 0 to (midBin - 1) by curveResolutionInput
        int k = midBin - 1 - i
        chart.point p = chart.point.from_index(int(array.get(curveX, k)), lows + (binStep * k) + (binStep / 2))
        array.push(cpB_f, p)
        array.push(cpB_l, p)
    array.push(cpB_f, chart.point.from_index(bar_index + curvesOffsetInput, lows))

    var polyline pS = na, polyline.delete(pS), var polyline pB = na, polyline.delete(pB)
    var polyline pSL = na, polyline.delete(pSL), var polyline pBL = na, polyline.delete(pBL)
    
    pS  := polyline.new(cpS_f, closed = true,  fill_color = color.new(bearColorInput, 80), line_color = na)
    pB  := polyline.new(cpB_f, closed = true,  fill_color = color.new(bullColorInput, 80), line_color = na)
    pSL := polyline.new(cpS_l, closed = false, line_color = bearColorInput, line_width = 2)
    pBL := polyline.new(cpB_l, closed = false, line_color = bullColorInput, line_width = 2)

    // --- Dynamic Label Positioning for Polylines ---
    float xHeatmapEnd = float(bar_index)
    float xSpine      = bar_index + curvesOffsetInput
    float xMid        = bar_index + (curvesOffsetInput / 2)
    
    // Get actual bulge depth at the outer-most bins
    float xUpperTip = array.get(curveX, BINS_COUNT - 1)
    float xLowerTip = array.get(curveX, 0)
    
    // Logic: 
    // - If bulge is missing/zero: Anchor to Heatmap Edge (bar_index)
    // - If bulge is large (past mid): Anchor to Midpoint
    // - If bulge is small (present but before mid): Anchor to the Bulge Tip Vertex
    float labelXUp = upperVolTotal == 0 or xUpperTip >= xSpine ? xHeatmapEnd : (xUpperTip <= xMid ? xMid : xUpperTip)
    float labelXDn = lowerVolTotal == 0 or xLowerTip >= xSpine ? xHeatmapEnd : (xLowerTip <= xMid ? xMid : xLowerTip)

    var label lblUp = na, label.delete(lblUp), var label lblDn = na, label.delete(lblDn)
    lblUp := label.new(int(labelXUp), highs, "Upper Vol: " + str.tostring(upperVolTotal, format.volume), 
         color     = bearColorInput, 
         style     = labelXUp == xMid ? label.style_label_down : label.style_label_right, 
         textcolor = color.white, 
         size      = size.small)
         
    lblDn := label.new(int(labelXDn), lows,  "Lower Vol: " + str.tostring(lowerVolTotal, format.volume), 
         color     = bullColorInput, 
         style     = labelXDn == xMid ? label.style_label_up : label.style_label_right,   
         textcolor = color.white, 
         size      = size.small)

    if showDashInput
        var table dash = table.new(parsedDashPos, 2, 13, bgcolor = BACKGROUND, frame_color = BORDERS, frame_width = 1)
        table.merge_cells(dash, 0, 0, 1, 0), cell(dash, 0, 0, "Liquidity Depth", DATA, text.align_center), divider(dash, 1, 1)
        cell(dash, 0, 2, "POC Price", HEADERS, text.align_left), cell(dash, 1, 2, str.tostring(pocPrice, format.mintick), DATA)
        cell(dash, 0, 3, "Dist. to POC", HEADERS, text.align_left), cell(dash, 1, 3, str.tostring(distToPoc, "#.##") + "%", DATA)
        cell(dash, 0, 4, "VA Range", HEADERS, text.align_left), cell(dash, 1, 4, str.tostring(val, format.mintick) + " - " + str.tostring(vah, format.mintick), DATA)
        divider(dash, 5, 1)
        cell(dash, 0, 6, "Mass Skew", HEADERS, text.align_left), cell(dash, 1, 6, str.tostring(skewRatio, "#.##") + "x", DATA)
        cell(dash, 0, 7, "Upper Mass", bearColorInput, text.align_left), cell(dash, 1, 7, str.tostring(upperPerc, "#.##") + "%", DATA)
        cell(dash, 0, 8, "Lower Mass", bullColorInput, text.align_left), cell(dash, 1, 8, str.tostring(lowerPerc, "#.##") + "%", DATA)
        divider(dash, 9, 1)
        cell(dash, 0, 10, "Agg. Delta", HEADERS, text.align_left), cell(dash, 1, 10, str.tostring(deltaAgg, format.volume), deltaAgg >= 0 ? BULL_COLOR : BEAR_COLOR)
        cell(dash, 0, 11, "Range Loc.", HEADERS, text.align_left), cell(dash, 1, 11, str.tostring(rangeLoc, "#.##") + "%", DATA)
        cell(dash, 0, 12, "Total Volume", HEADERS, text.align_left), cell(dash, 1, 12, str.tostring(totalVol, format.volume), DATA)

// 8. Unusual Volume Alert
isUnusual = volume > volMa + (volThresholdInput * volStd)
alertcondition(isUnusual, "Unusual Volume Detected", "Extreme volume spike detected on {{ticker}}")
//---------------------------------------------------------------------------------------------------------------------}