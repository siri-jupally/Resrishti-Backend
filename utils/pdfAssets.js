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

module.exports = { getLogo, ASSETS_DIR };
