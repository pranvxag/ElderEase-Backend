function limitSmsText(text, limit = 149) {
    const value = String(text ?? '');
    const chars = Array.from(value);

    if (chars.length <= limit) {
        return value;
    }

    return chars.slice(0, limit).join('');
}

module.exports = { limitSmsText };