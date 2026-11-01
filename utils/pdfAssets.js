/*
  utils/pdfAssets.js — shared binary assets for the PDF renderers.

  Why this exists:
  - @react-pdf/renderer v4 resolves a STRING `src` on <Image> through fetch().
    An absolute filesystem path is not a URL, so `src: "D:\\...\\logo.png"`
    (or "/app/assets/logo.png" in the container) fails with "fetch failed" and
    the renderer silently omits the image — the PDF still generates, just
    without a logo. That is exactly what was happening to every issued
    Certificate of Disposal.
  - Passing `{ data: Buffer, format: "png" }` skips the fetch path entirely and
    embeds the bytes directly. That works identically on Windows dev machines
    and inside the Linux Docker image.

  Caching:
  - Read once per process and memoised. The logo is ~100KB; re-reading it for
    every certificate render would be wasted syscalls on a hot path.

  Failure handling:
  - A missing/unreadable asset returns null and the caller omits the element.
    A cosmetic asset must never be able to fail a legal document's generation.
*/

const fs = require("fs");
const path = require("path");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

let _logo; // undefined = not attempted yet, null = attempted and failed

/**
 * Company logo as a react-pdf image source.
 * @returns {{data: Buffer, format: string}|null}
 */
const getLogo = () => {
    if (_logo !== undefined) return _logo;
    try {
        const data = fs.readFileSync(path.join(ASSETS_DIR, "logo-resrishti.png"));
        _logo = { data, format: "png" };
    } catch (err) {
        console.warn("PDF logo asset unavailable, rendering without it:", err.message);
        _logo = null;
    }
    return _logo;
};

// ---- Certificate template assets (new GreenEarth designs) ----
// The CoD + Environmental Impact certificates were redesigned to match the
// client-supplied templates. Their graphics (logo, signature, seal, the gold
// swirl frame pieces, the impact icons) live in assets/cert/ and are loaded the
// same memoised, Buffer-based way as the logo above — a string path src breaks
// under react-pdf's fetch(), and a missing asset must never fail a document.
const path2 = require("path");
const CERT_DIR = path2.join(ASSETS_DIR, "cert");
const _certCache = Object.create(null);

/**
 * Load a certificate asset from assets/cert/ as a react-pdf image source.
 * @param {string} file  e.g. "cert-logo.png"
 * @returns {{data: Buffer, format: string}|null}
 */
const getCertAsset = (file) => {
    if (file in _certCache) return _certCache[file];
    try {
        const data = fs.readFileSync(path.join(CERT_DIR, file));
        const ext = path.extname(file).slice(1).toLowerCase();
        const format = ext === "jpg" ? "jpeg" : ext; // react-pdf wants "jpg"->"jpeg"? accepts png/jpg
        _certCache[file] = { data, format: format === "jpeg" ? "jpg" : format };
    } catch (err) {
        console.warn(`PDF cert asset '${file}' unavailable, rendering without it:`, err.message);
        _certCache[file] = null;
    }
    return _certCache[file];
};

module.exports = { getLogo, getCertAsset, ASSETS_DIR, CERT_DIR };
