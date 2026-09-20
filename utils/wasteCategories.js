/*
  utils/wasteCategories.js — one place that answers "what waste streams exist,
  what are they called, and what is each one worth in CO2e?"

  Why a cache:
  Certificates, the public impact counter and the CoD PDF all look up a stream
  synchronously, deep inside rendering code. Turning every one of those into an
  await would be a large, risky change. Instead the whole list (it is a dozen
  short documents) is held in memory, refreshed when the server starts and
  again after every admin edit, and falls back to the original hard-coded
  eleven until the first load finishes. Nothing can get worse than today's
  behaviour, even if Mongo is unreachable.

  Anything that validates client input should use the async helpers
  (`isKnownStream`, `activeStreamKeys`) so a stream added on another instance
  is accepted straight away rather than waiting for this cache to catch up.
*/
const WasteCategory = require("../models/WasteCategory");

// The eleven original streams, with the factors and certificate buckets that
// were previously hard-coded in utils/emissionFactors.js and
// utils/certificatePdf.js. These seed the collection and act as the fallback.
const CORE_CATEGORIES = [
    { key: "plastic", label: "Plastic", co2eFactorKgPerKg: 1.5, certificateBucket: "plastic", sortOrder: 10 },
    { key: "paper", label: "Paper", co2eFactorKgPerKg: 0.94, certificateBucket: "paper", sortOrder: 20 },
    { key: "ewaste", label: "E-Waste", co2eFactorKgPerKg: 1.44, certificateBucket: "ewaste", sortOrder: 30 },
    { key: "biomedical", label: "Biomedical", co2eFactorKgPerKg: 1.1, certificateBucket: "other-dry", sortOrder: 40 },
    { key: "foam-thermocol", label: "Foam / Thermocol", co2eFactorKgPerKg: 0.6, certificateBucket: "other-dry", sortOrder: 50 },
    { key: "dry-waste", label: "Dry Waste", co2eFactorKgPerKg: 0.4, certificateBucket: "other-dry", sortOrder: 60 },
    { key: "agr", label: "AGR", co2eFactorKgPerKg: 0.3, certificateBucket: "other-dry", sortOrder: 70 },
    { key: "battery", label: "Battery", co2eFactorKgPerKg: 1.2, certificateBucket: "ewaste", sortOrder: 80 },
    { key: "expired-food", label: "Expired Food", co2eFactorKgPerKg: 0.5, certificateBucket: "wet", sortOrder: 90 },
    { key: "hazardous", label: "Hazardous", co2eFactorKgPerKg: 1.6, certificateBucket: "other-dry", sortOrder: 100 },
    { key: "other", label: "Other", co2eFactorKgPerKg: 0.5, certificateBucket: "other-dry", sortOrder: 110 },
];

// Used when a stream is not in the list at all — same number the old
// emissionFactors.js fell back to.
const DEFAULT_FACTOR = 0.5;
const DEFAULT_BUCKET = "other-dry";

const coreShape = (c) => ({ ...c, isActive: true, isCore: true });

let cache = CORE_CATEGORIES.map(coreShape);
let cacheByKey = new Map(cache.map((c) => [c.key, c]));
let loadedAt = 0;

const setCache = (rows) => {
    cache = rows;
    cacheByKey = new Map(rows.map((c) => [c.key, c]));
    loadedAt = Date.now();
};

/**
 * Insert any core category that is missing. Never overwrites an edited one —
 * an admin who corrected a factor keeps their correction across restarts.
 */
const seedCoreCategories = async () => {
    const existing = await WasteCategory.find({}, "key").lean();
    const have = new Set(existing.map((c) => c.key));
    const missing = CORE_CATEGORIES.filter((c) => !have.has(c.key)).map(coreShape);
    if (missing.length > 0) {
        await WasteCategory.insertMany(missing, { ordered: false });
    }
    return missing.length;
};

/** Reload the in-memory list from Mongo. Safe to call often. */
const refreshCache = async () => {
    const rows = await WasteCategory.find({}).sort({ sortOrder: 1, label: 1 }).lean();
    if (rows.length > 0) setCache(rows);
    return cache;
};

/** Seed then load — call once after the Mongo connection opens. */
const initWasteCategories = async () => {
    const seeded = await seedCoreCategories();
    await refreshCache();
    return seeded;
};

// ---- synchronous readers (cache only) -------------------------------------

const allCategories = () => cache;
const activeCategories = () => cache.filter((c) => c.isActive !== false);
const categoryFor = (key) => cacheByKey.get(key) || null;
const labelForStream = (key) => categoryFor(key)?.label || key;
const factorForStream = (key) => {
    const found = categoryFor(key);
    const f = found?.co2eFactorKgPerKg;
    return Number.isFinite(f) ? f : DEFAULT_FACTOR;
};
const bucketForStream = (key) => categoryFor(key)?.certificateBucket || DEFAULT_BUCKET;

// ---- async readers (authoritative) ----------------------------------------

/**
 * Is this a stream we know about at all? Checks the cache first, then Mongo —
 * so a category added a second ago on another instance is still accepted.
 */
const isKnownStream = async (key) => {
    if (!key) return false;
    if (cacheByKey.has(key)) return true;
    const found = await WasteCategory.exists({ key });
    if (found) await refreshCache();
    return Boolean(found);
};

/** Keys a client may request a pickup for right now. */
const activeStreamKeys = async () => {
    await refreshCache();
    return activeCategories().map((c) => c.key);
};

/** Every key ever configured — used when validating a correction to old data. */
const allStreamKeys = async () => {
    await refreshCache();
    return cache.map((c) => c.key);
};

module.exports = {
    CORE_CATEGORIES,
    DEFAULT_FACTOR,
    DEFAULT_BUCKET,
    seedCoreCategories,
    refreshCache,
    initWasteCategories,
    allCategories,
    activeCategories,
    categoryFor,
    labelForStream,
    factorForStream,
    bucketForStream,
    isKnownStream,
    activeStreamKeys,
    allStreamKeys,
    get lastLoadedAt() {
        return loadedAt;
    },
};
