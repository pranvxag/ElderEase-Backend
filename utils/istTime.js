/**
 * IST Time Utilities
 * Ensures all timestamps and dates use Indian Standard Time (UTC+5:30)
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/**
 * Get current time in IST
 * @param {Date} date - Optional date to convert to IST (default: now)
 * @returns {Date} Date object adjusted to IST
 */
function getIST(date = new Date()) {
    return new Date(date.getTime() + IST_OFFSET_MS);
}

/**
 * Get today's date in IST as YYYY-MM-DD string
 * @param {Date} date - Optional date to use (default: now)
 * @returns {string} Date in YYYY-MM-DD format
 */
function getTodayIST(date = new Date()) {
    const ist = getIST(date);
    const year = ist.getUTCFullYear();
    const month = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const day = String(ist.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Get current time in IST as HH:MM string
 * @param {Date} date - Optional date to use (default: now)
 * @returns {string} Time in HH:MM format
 */
function getTimeIST(date = new Date()) {
    const ist = getIST(date);
    const hours = String(ist.getUTCHours()).padStart(2, '0');
    const minutes = String(ist.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/**
 * Get current ISO string in IST
 * @param {Date} date - Optional date to use (default: now)
 * @returns {string} ISO string (UTC-based but represents IST)
 */
function getISOStringIST(date = new Date()) {
    const ist = getIST(date);
    return ist.toISOString();
}

/**
 * Get formatted time string for display (with AM/PM)
 * @param {Date} date - Optional date to use (default: now)
 * @returns {string} Formatted time like "10:30 AM"
 */
function getFormattedTimeIST(date = new Date()) {
    const ist = getIST(date);
    const hours = ist.getUTCHours();
    const minutes = String(ist.getUTCMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = String((hours % 12) || 12).padStart(2, '0');
    return `${displayHours}:${minutes} ${ampm}`;
}

module.exports = {
    IST_OFFSET_MS,
    getIST,
    getTodayIST,
    getTimeIST,
    getISOStringIST,
    getFormattedTimeIST,
};
