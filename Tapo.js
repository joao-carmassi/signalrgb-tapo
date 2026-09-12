// =============================================================================
// Tapo — SignalRGB Plugin  v3.1.2
// Supports all tapo-rest devices (L5xx, L6xx, L9xx, P1xx)
// Requires: tapo-rest running locally (https://github.com/ClementNerma/tapo-rest)
// Transport: XMLHttpRequest
// =============================================================================

// Controllable parameter globals — declared as var so the SignalRGB runtime
// can overwrite them; defaults are used until the first Render() injection.
var LightingMode    = "Canvas";
var forcedColor     = "0099ff";
var brightnessScale = "100";
var updateInterval  = "0";
var intervalSampling = "Average";

// -- Configuration ------------------------------------------------------------

const HOST     = "127.0.0.1";
const PORT     = 8000;
const PASSWORD = "";

// Minimum canvas frames between sends (~5fps at SignalRGB's default 30fps)
let FRAME_SKIP  = 6;

// Minimum HSV delta (0–100) before sending a new command
let MIN_DELTA   = 3;

// Colors this close to neutral are treated as white and sent as a color
// temperature instead of hue/saturation. The Tapo API rejects saturation=0
// outright, and saturations of 1-10 render as tinted pastels rather than white.
//
// The test is absolute chroma (max channel - min channel, 0-255), NOT HSV
// saturation. Saturation is a ratio, so on a dark screen a one-unit channel
// imbalance reads as a large saturation with an essentially random hue:
// (10,10,11) is visually black but scores saturation 9, hue 240. Absolute
// chroma is scale-invariant and stays small when the scene really is neutral.
//
// The two thresholds form a hysteresis band. A scene parked on a single
// boundary would otherwise flip modes on sensor noise alone, and a mode flip
// bypasses the whole delta gate.
const CHROMA_ENTER_COLOR = 24;   // rise above this to leave white mode
const CHROMA_STAY_COLOR  = 16;   // fall below this to return to white mode

// Below this value (HSV V, 0-100) chroma carries no usable signal at all, so
// the scene is driven as dim white rather than as a noise-derived hue.
const DARK_V_FLOOR = 4;

// Chromaticity is scale-invariant, so a one-unit channel difference is a
// rounding error at RGB 255 but a large chromatic shift at RGB 20. Below
// CCT_TRUST_V_LO the Kelvin estimate is reading quantization noise, so a dark
// neutral scene is pinned to the display's own white point; above
// CCT_TRUST_V_HI it is used as computed. In between it is blended, because a
// hard cutoff is a cliff that dither walks back and forth across, which is the
// very hunting this is meant to stop.
const CCT_TRUST_V_LO = 15;
const CCT_TRUST_V_HI = 35;

// The same argument applies to chroma itself. At a chroma of 1 or 2 the scene
// is the display white point plus rounding, and the Kelvin figure derived from
// it swings freely, so a bright neutral screen would chatter. Trust the
// estimate only once there is real chroma to measure.
const CCT_TRUST_C_LO = 2;
const CCT_TRUST_C_HI = 6;

const CCT_NEUTRAL    = 6500;   // D65, the sRGB white point

// Minimum change in Kelvin before a new color temperature is sent. This bounds
// how far the settled white can sit from the screen, so two crossfades onto the
// same white from different covers can differ by up to twice this. Measured on
// an eased crossfade: 120 leaves a 133K spread, 60 converges exactly, and the
// extra traffic stays well under the ceiling frameSkip already imposes.
const CCT_DELTA = 60;

// Clamp range accepted by the Tapo color-temperature API (Kelvin)
const CCT_MIN = 2500;
const CCT_MAX = 6500;

let sessionToken   = null;
let frameCounter   = 0;
let requestPending = false;
let lastHue        = -1;
let lastSat        = -1;
let lastBri        = -1;
let lastCct        = -1;
let lastMode       = null;   // "hs" | "cct" — forces a resend when the mode flips

// Timed updates (updateInterval > 0): one color per window, sent at its end,
// leaving the device to fade to it. The first frame opens no window.
let windowStart = -Infinity;
let sumR = 0, sumG = 0, sumB = 0, sampleCount = 0;

// How long the device takes to fade to a new state on its own (~1 s on an
// L530). A window longer than this would fade and then sit still until the
// next window, so a sequence of changes reads as change, pause, change. The
// move to each window's color is instead split into steps this long, each
// heading for an intermediate color, so one fade runs straight into the next.
const DEVICE_FADE_MS = 1000;

let glideFrom  = null;   // [r,g,b] the current glide starts from
let glideTo    = null;   // [r,g,b] the window color it ends on
let glideSent  = null;   // [r,g,b] the last step handed to the device
let glideSteps = 0;
let glideStep  = 0;

// Whether tapo-rest has the combined `set` action. null until the first
// attempt; false once the route turns out to be missing (older tapo-rest).
// A missing route is retried after a while, so upgrading tapo-rest takes
// effect without restarting SignalRGB.
let combinedSet = null;
let combinedSetMissingAt = 0;
const COMBINED_SET_RETRY_MS = 60000;

// -- Device identity ----------------------------------------------------------

export function Name()      { return "Tapo"; }
export function Publisher() { return "SignalRGB Community"; }
export function Version()   { return "3.1.2"; }
export function Type()      { return "network"; }

export function SubdeviceController() { return true; }

export function ImageUrl() { return "https://i.ibb.co/0ytq0n9Q/tapo.jpg"; }

export function DefaultPosition() { return [0, 0]; }
export function DefaultScale()    { return 1.0; }

export function Size() { return [1, 1]; }

// -- Device capability detection ----------------------------------------------

// Returns what a given device type can do.
// color  → supports set-hue-saturation
// dim    → supports set-brightness
// leds   → how many LEDs to register in the channel
function deviceCaps(type) {
    const t = type.toLowerCase();
    if (/^l9(00|20|30)/.test(t)) return { color: true,  dim: true,  leds: 40 }; // RGBIC strips
    if (/^l(530|535|630)/.test(t)) return { color: true,  dim: true,  leds: 1  }; // color bulbs
    if (/^l(510|520|610)/.test(t)) return { color: false, dim: true,  leds: 1  }; // dimmable bulbs
    return                                 { color: false, dim: false, leds: 1  }; // plugs / unknown
}

// -- Discovery service --------------------------------------------------------

export function DiscoveryService() {
    const disc = this;
    let discoveryToken = null;
    this.IconUrl = "https://i.ibb.co/0ytq0n9Q/tapo.jpg";
    let host     = HOST;
    let port     = PORT;
    let password = PASSWORD;

    // Called once when SignalRGB loads the plugin.
    this.Initialize = function() {
        const savedHost      = service.getSetting("tapoRest",   "host");
        const savedPort      = service.getSetting("tapoRest",   "port");
        const savedPass      = service.getSetting("tapoRest",   "password");
        const savedFrameSkip = service.getSetting("tapoRender", "frameSkip");
        const savedMinDelta  = service.getSetting("tapoRender", "minDelta");

        if (savedHost) host      = savedHost;
        if (savedPort) port      = parseInt(savedPort);
        if (savedPass) password  = savedPass;
        if (savedFrameSkip) FRAME_SKIP = parseInt(savedFrameSkip);
        if (savedMinDelta !== undefined && savedMinDelta !== "") MIN_DELTA = parseInt(savedMinDelta);

        disc.host      = host;
        disc.port      = port;
        disc.password  = password;
        disc.frameSkip = FRAME_SKIP;
        disc.minDelta  = MIN_DELTA;

        service.log("[Tapo] Connecting to tapo-rest @ " + host + ":" + port);
        serviceLogin();
    };

    // Called periodically by SignalRGB — announce any pending controllers.
    this.Update = function() {
        for (const cont of service.controllers) {
            const bridge = cont.obj;
            if (!bridge.announced) {
                bridge.announced = true;
                service.log("[Tapo] Announcing: " + bridge.name);
                service.announceController(bridge);
            }
        }
    };

    this.Discovered = function(value) {
        if (service.getController(value.id) === undefined) {
            service.addController(new TapoBridge(value));
        }
    };

    // Called from QML to update and persist the tapo-rest connection config.
    this.setServerConfig = function(newHost, newPort, newPassword) {
        host     = newHost           || host;
        port     = parseInt(newPort) || port;
        password = newPassword       || password;

        service.saveSetting("tapoRest", "host",     host);
        service.saveSetting("tapoRest", "port",     String(port));
        service.saveSetting("tapoRest", "password", password);

        disc.host     = host;
        disc.port     = port;
        disc.password = password;

        // Remove existing controllers and rediscover with new config.
        for (const cont of service.controllers) {
            service.removeController(cont);
        }
        discoveryToken = null;
        serviceLogin();
    };

    // Called from QML to update and persist the render tuning config.
    this.setRenderConfig = function(newFrameSkip, newMinDelta) {
        const fs = parseInt(newFrameSkip);
        const md = parseInt(newMinDelta);
        if (!isNaN(fs) && fs >= 1) FRAME_SKIP = fs;
        if (!isNaN(md) && md >= 0) MIN_DELTA  = md;

        service.saveSetting("tapoRender", "frameSkip", String(FRAME_SKIP));
        service.saveSetting("tapoRender", "minDelta",  String(MIN_DELTA));

        disc.frameSkip = FRAME_SKIP;
        disc.minDelta  = MIN_DELTA;

        // Propagate live to all existing device instances.
        for (const cont of service.controllers) {
            cont.obj.frameSkip = FRAME_SKIP;
            cont.obj.minDelta  = MIN_DELTA;
        }
    };

    function serviceLogin() {
        service.log("[Tapo] POST /login ...");
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `http://${host}:${port}/login`, true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) return;
            service.log("[Tapo] /login → HTTP " + xhr.status);
            if (xhr.status === 200) {
                discoveryToken = xhr.responseText.trim().replace(/^"|"$/g, "");
                service.log("[Tapo] Discovery token acquired");
                fetchDevices();
            } else {
                service.log("[Tapo] Discovery login failed — body: " + xhr.responseText);
            }
        };
        xhr.send(JSON.stringify({ password: password }));
    }

    function fetchDevices() {
        service.log("[Tapo] GET /devices ...");
        const xhr = new XMLHttpRequest();
        xhr.open("GET", `http://${host}:${port}/devices`, true);
        xhr.setRequestHeader("Authorization", "Bearer " + discoveryToken);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) return;
            service.log("[Tapo] /devices → HTTP " + xhr.status + " — " + xhr.responseText);
            if (xhr.status === 200) {
                const devices = JSON.parse(xhr.responseText);
                service.log("[Tapo] Found " + devices.length + " device(s)");
                for (const dev of devices) {
                    service.log("[Tapo] Device: " + JSON.stringify(dev));
                    disc.Discovered({
                        id:         host + ":" + port + "/" + dev.name,
                        name:       "Tapo " + dev.device_type.toUpperCase() + " – " + dev.name,
                        ip:         host,
                        port:       port,
                        password:   password,
                        deviceName: dev.name,
                        deviceType: dev.device_type.toLowerCase(),
                        frameSkip:  FRAME_SKIP,
                        minDelta:   MIN_DELTA,
                    });
                }
            } else {
                service.log("[Tapo] Failed to fetch devices — body: " + xhr.responseText);
            }
        };
        xhr.send();
    }
}

// Holds per-device connection state. Passed to the plugin instance as `controller`.
class TapoBridge {
    constructor(value) {
        this.id         = value.id;
        this.name       = value.name;
        this.ip         = value.ip;
        this.port       = value.port;
        this.password   = value.password;
        this.deviceName = value.deviceName;
        this.deviceType = value.deviceType;
        this.frameSkip  = value.frameSkip !== undefined ? value.frameSkip : FRAME_SKIP;
        this.minDelta   = value.minDelta  !== undefined ? value.minDelta  : MIN_DELTA;
        this.announced  = false;  // set true by Update() before announcing

        service.log("[Tapo] Controller ready: " + this.name + " @ " + this.ip + ":" + this.port);
    }
}

export function ControllableParameters() {
    return [
        {
            property: "LightingMode",
            group:    "lighting",
            label:    "Lighting Mode",
            type:     "combobox",
            values:   ["Canvas", "Forced"],
            default:  "Canvas"
        },
        {
            property: "forcedColor",
            group:    "lighting",
            label:    "Forced Color",
            type:     "color",
            default:  "0099ff"
        },
        {
            property: "brightnessScale",
            group:    "lighting",
            label:    "Brightness (%)",
            type:     "number",
            min:      "1",
            max:      "100",
            step:     "1",
            default:  "100"
        },
        {
            property: "updateInterval",
            group:    "lighting",
            label:    "Update Interval (s)",
            type:     "number",
            min:      "0",
            max:      "30",
            step:     "1",
            default:  "0"
        },
        {
            property: "intervalSampling",
            group:    "lighting",
            label:    "Interval Sampling",
            type:     "combobox",
            values:   ["Average", "Last Frame"],
            default:  "Average"
        }
    ];
}

// -- Lifecycle ----------------------------------------------------------------

export function Initialize() {
    const caps = deviceCaps(controller.deviceType);
    device.setName(controller.name);
    device.addChannel("Strip", caps.leds);
    device.log(`[Tapo] [${controller.deviceName}] type=${controller.deviceType} color=${caps.color} dim=${caps.dim} leds=${caps.leds}`);
    login();
}

export function Render() {
    if (sessionToken === null) {
        login();
        return;
    }

    let r, g, b;
    const sample = () => LightingMode === "Forced" ? hexToRgb(forcedColor) : averageCanvas();
    const intervalMs = (parseFloat(updateInterval) || 0) * 1000;

    if (intervalMs > 0) {
        // Every device command starts a fade that the next command cuts short,
        // so a fast stream reads as hard cuts. Send one color per window.
        //   Average    — mean of the window; steady, never lands on the dark gap
        //                between beats, but opposing colors blend together.
        //   Last Frame — the canvas as the window closes; keeps colors vivid,
        //                but which beat it catches is arbitrary.
        [r, g, b] = sample();
        sumR += r; sumG += g; sumB += b; sampleCount++;

        const now = Date.now();
        if (now - windowStart >= intervalMs) {
            const target = intervalSampling === "Last Frame"
                ? [r, g, b]
                : [sumR, sumG, sumB].map((sum) => Math.round(sum / sampleCount));
            sumR = sumG = sumB = sampleCount = 0;
            windowStart = now;

            // Glide from wherever the device was last sent, which is short of
            // the previous window color if its steps were held back.
            glideFrom  = glideSent || target;
            glideTo    = target;
            glideSteps = Math.max(1, Math.round(intervalMs / DEVICE_FADE_MS));
            glideStep  = 0;
        }

        const stepDue = windowStart + glideStep * (intervalMs / glideSteps);
        if (glideTo === null || glideStep >= glideSteps || now < stepDue || requestPending) return;

        glideStep++;
        [r, g, b] = glideSent = mixColors(glideFrom, glideTo, glideStep / glideSteps);
    } else {
        sumR = sumG = sumB = sampleCount = 0;
        glideFrom = glideTo = glideSent = null;
        frameCounter++;
        if (frameCounter < controller.frameSkip) return;
        frameCounter = 0;

        if (requestPending) return;

        [r, g, b] = sample();
    }

    const [h, s, v] = rgbToHsv(r, g, b);
    const scaledBri = Math.round(v * (parseInt(brightnessScale) / 100));
    const minDelta  = controller.minDelta;
    const chroma    = Math.max(r, g, b) - Math.min(r, g, b);
    const cct       = trustedCct(r, g, b, v, chroma);

    // Pick the bulb mode from absolute chroma, with hysteresis around the
    // boundary and a hard floor for very dark scenes.
    let mode;
    if (v < DARK_V_FLOOR)        mode = "cct";
    else if (lastMode === "hs")  mode = chroma > CHROMA_STAY_COLOR  ? "hs" : "cct";
    else                         mode = chroma > CHROMA_ENTER_COLOR ? "hs" : "cct";

    // Gate on whatever this mode actually transmits. In white mode that is the
    // Kelvin value, which no combination of hue, saturation and brightness
    // stands in for: two whites of opposite tint share the same saturation, so
    // gating on saturation lets the bulb park on a stale tint indefinitely.
    const colorSettled = mode === "cct"
        ? Math.abs(cct - lastCct) < CCT_DELTA
        : hueDelta(h, lastHue) < minDelta && Math.abs(s - lastSat) < minDelta;

    // Switching the bulb on or off is not a delta. A fade whose last step into
    // black is smaller than minDelta would otherwise leave the bulb lit at 1%.
    const powerChanged = (scaledBri === 0) !== (lastBri === 0);

    if (
        !powerChanged &&
        mode === lastMode &&
        colorSettled &&
        Math.abs(scaledBri - lastBri) < minDelta
    ) return;

    lastHue  = h;
    lastSat  = s;
    lastBri  = scaledBri;
    lastCct  = cct;
    lastMode = mode;

    sendColor(h, s, scaledBri, mode, cct);
}

export function Shutdown() {
    if (!sessionToken) return;
    const dt   = controller.deviceType.toLowerCase();
    const dn   = controller.deviceName;
    const caps = deviceCaps(dt);
    // Reset color devices to warm white; everything else just turns off
    if (caps.color) {
        httpGet(`/actions/${dt}/set-color-temperature?device=${dn}&color_temperature=3000`, null);
    } else {
        httpGet(`/actions/${dt}/off?device=${dn}`, null);
    }
}

// -- HTTP helpers -------------------------------------------------------------

// callback(statusCode, responseBody) — called once when the request completes.
function httpRequest(method, path, bodyObj, callback) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `http://${controller.ip}:${controller.port}${path}`, true);

    if (sessionToken) {
        xhr.setRequestHeader("Authorization", "Bearer " + sessionToken);
    }
    if (bodyObj) {
        xhr.setRequestHeader("Content-Type", "application/json");
    }

    xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
            if (callback) callback(xhr.status, xhr.responseText);
        }
    };

    xhr.send(bodyObj ? JSON.stringify(bodyObj) : null);
}

// Convenience wrappers
function httpPost(path, bodyObj, callback) {
    httpRequest("POST", path, bodyObj, callback);
}

function httpGet(path, callback) {
    httpRequest("GET", path, null, callback);
}

// -- Auth & color commands ----------------------------------------------------

function login() {
    if (requestPending) return;
    requestPending = true;

    device.log(`[Tapo] [${controller.deviceName}] POST /login ...`);
    httpPost("/login", { password: controller.password }, (status, body) => {
        requestPending = false;
        device.log(`[Tapo] [${controller.deviceName}] /login → HTTP ${status}`);
        if (status === 200) {
            sessionToken = body.trim().replace(/^"|"$/g, "");
            device.log(`[Tapo] [${controller.deviceName}] Session token acquired`);
        } else {
            device.log(`[Tapo] [${controller.deviceName}] Login failed — body: ${body}`);
        }
    });
}

function sendColor(hue, saturation, bri, mode, cct) {
    const dt   = controller.deviceType.toLowerCase();
    const dn   = controller.deviceName;
    const caps = deviceCaps(dt);

    device.log(`[Tapo] [${dn}] sendColor mode=${mode} h=${hue} s=${saturation} v=${bri} cct=${cct} (color=${caps.color} dim=${caps.dim})`);

    // Turn off when brightness hits zero
    if (bri === 0) {
        requestPending = true;
        httpGet(`/actions/${dt}/off?device=${dn}`, () => { requestPending = false; });
        return;
    }

    requestPending = true;

    function handle401(status) {
        if (status === 401) { sessionToken = null; requestPending = false; return true; }
        return false;
    }

    // Any non-2xx means the bulb kept its previous color — clear the cached
    // state so the next frame retries instead of being skipped by the delta gate.
    function checkFailure(label, status) {
        if (status >= 200 && status < 300) return false;
        device.log(`[Tapo] [${dn}] ${label} failed — HTTP ${status}`);
        invalidateSentState();
        return true;
    }

    const colorParams = mode === "cct"
        // Whites: the Tapo API rejects saturation=0 and renders low
        // saturations as tinted pastels, so use color-temperature mode.
        ? `color_temperature=${cct}`
        : `hue=${hue}&saturation=${saturation}`;

    // Color and brightness in one device command. Sent separately, the
    // brightness command lands mid-way through the color fade and cuts it off.
    // Setting brightness also turns the device on, so no /on is needed.
    if (combinedSet === false && Date.now() - combinedSetMissingAt >= COMBINED_SET_RETRY_MS) {
        combinedSet = null;
    }

    if (caps.color && combinedSet !== false) {
        httpGet(`/actions/${dt}/set?device=${dn}&brightness=${bri}&${colorParams}`, (status, body) => {
            if (handle401(status)) return;
            // An unknown route is a bare 404; a missing device carries a message.
            if (status === 404 && !body) {
                device.log(`[Tapo] [${dn}] tapo-rest has no /set action — using separate commands`);
                combinedSet = false;
                combinedSetMissingAt = Date.now();
                invalidateSentState();
            } else if (!checkFailure("set", status)) {
                combinedSet = true;
            }
            requestPending = false;
        });
        return;
    }

    // All devices: turn on first
    httpGet(`/actions/${dt}/on?device=${dn}`, (s1) => {
        device.log(`[Tapo] [${dn}] /on → HTTP ${s1}`);
        if (handle401(s1)) return;

        if (caps.color) {
            const colorPath = mode === "cct"
                ? `/actions/${dt}/set-color-temperature?device=${dn}&${colorParams}`
                : `/actions/${dt}/set-hue-saturation?device=${dn}&${colorParams}`;

            httpGet(colorPath, (s2) => {
                if (handle401(s2)) return;
                checkFailure(mode === "cct" ? "set-color-temperature" : "set-hue-saturation", s2);
                httpGet(`/actions/${dt}/set-brightness?device=${dn}&level=${bri}`, (s3) => {
                    if (s3 === 401) sessionToken = null;
                    else checkFailure("set-brightness", s3);
                    requestPending = false;
                });
            });
        } else if (caps.dim) {
            // Dimmable only: set brightness
            httpGet(`/actions/${dt}/set-brightness?device=${dn}&level=${bri}`, (s2) => {
                if (s2 === 401) sessionToken = null;
                else checkFailure("set-brightness", s2);
                requestPending = false;
            });
        } else {
            // Switch only: on/off already handled above
            requestPending = false;
        }
    });
}

// Blend two RGB colors at t (0–1). The peak channel is interpolated separately
// so brightness moves in a straight line: a plain RGB mix of red and blue
// passes through a half-bright purple, which would read as a dip.
function mixColors(from, to, t) {
    const mixed = from.map((c, i) => c + (to[i] - c) * t);
    const peak  = Math.max(...from) + (Math.max(...to) - Math.max(...from)) * t;
    const max   = Math.max(...mixed);
    const scale = max > 0 ? peak / max : 0;
    return mixed.map((c) => Math.round(Math.min(255, c * scale)));
}

// Forget what was last sent, so the delta gate lets the next frame through.
function invalidateSentState() {
    lastHue = lastSat = lastBri = lastCct = -1;
    lastMode = null;
}

// -- Canvas / color helpers ---------------------------------------------------

function averageCanvas() {
    const colors = device.channel("Strip").getColors("Inline"); // [R,G,B, R,G,B, ...]
    const count  = colors.length / 3;
    let rSum = 0, gSum = 0, bSum = 0;

    for (let i = 0; i < colors.length; i += 3) {
        rSum += colors[i];
        gSum += colors[i + 1];
        bSum += colors[i + 2];
    }

    return [
        Math.round(rSum / count),
        Math.round(gSum / count),
        Math.round(bSum / count)
    ];
}

// Color temperature for a frame, faded toward the display white point as the
// scene gets too dark for its chromaticity to mean anything.
function trustedCct(r, g, b, v, chroma) {
    const ramp = (x, lo, hi) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
    const w = Math.min(
        ramp(v,      CCT_TRUST_V_LO, CCT_TRUST_V_HI),
        ramp(chroma, CCT_TRUST_C_LO, CCT_TRUST_C_HI),
    );
    if (w === 0) return CCT_NEUTRAL;
    const raw = rgbToCct(r, g, b);
    return Math.round(CCT_NEUTRAL + w * (raw - CCT_NEUTRAL));
}

// Shortest angular distance between two hues, in degrees (0–180). Hue is
// circular, so a plain subtraction reports 358 for the 1-degree gap between
// 359 and 0 — which would defeat the rate limit on red content.
// A negative previous hue means "nothing cached yet", so report max distance.
function hueDelta(a, b) {
    if (b < 0) return 180;
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

// RGB (0–255) → [H 0–360, S 0–100, V 0–100]
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;

    const max  = Math.max(r, g, b);
    const min  = Math.min(r, g, b);
    const diff = max - min;

    let h = 0;
    if (diff !== 0) {
        if      (max === r) h = 60 * (((g - b) / diff) % 6);
        else if (max === g) h = 60 * (((b - r) / diff) + 2);
        else                h = 60 * (((r - g) / diff) + 4);
    }
    if (h < 0) h += 360;

    const s = max === 0 ? 0 : (diff / max) * 100;
    const v = max * 100;

    // Saturation is clamped to 1 because the Tapo API rejects 0; anything that
    // low is routed to color-temperature mode by the caller anyway.
    return [
        Math.min(360, Math.max(0, Math.round(h))),
        Math.min(100, Math.max(1, Math.round(s))),
        Math.min(100, Math.max(0, Math.round(v)))
    ];
}

// RGB (0–255) → correlated color temperature in Kelvin, via sRGB → XYZ → xy
// and McCamy's approximation. Used for near-white colors, where hue/saturation
// cannot express the tint the canvas is asking for.
function rgbToCct(r, g, b) {
    // Linearize sRGB
    const lin = (c) => {
        c /= 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const R = lin(r), G = lin(g), B = lin(b);

    const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;

    const sum = X + Y + Z;
    if (sum === 0) return 4000;

    const x = X / sum;
    const y = Y / sum;

    // McCamy: n = (x - 0.3320) / (0.1858 - y)
    const denom = 0.1858 - y;
    if (Math.abs(denom) < 1e-6) return 4000;
    const n = (x - 0.3320) / denom;

    const cct = 437 * n * n * n + 3601 * n * n + 6861 * n + 5517;
    if (!isFinite(cct)) return 4000;

    return Math.round(Math.min(CCT_MAX, Math.max(CCT_MIN, cct)));
}

function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
