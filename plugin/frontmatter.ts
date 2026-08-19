/**
 * Merge keys into a Markdown file's YAML frontmatter.
 * The replacement must be a function: String.replace treats $1/$& in a
 * string replacement as capture-group inserts, which corrupts values like $15.
 */
export function applyFrontmatterUpdates(
    content: string,
    updates: Record<string, unknown>
): string {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
    const match = content.match(frontmatterRegex);

    if (match) {
        const existingLines = match[1].split('\n');
        const existingMap = new Map<string, number>();
        existingLines.forEach((line, idx) => {
            const keyMatch = line.match(/^(\S+):/);
            if (keyMatch) existingMap.set(keyMatch[1], idx);
        });

        const newFrontmatterLines = [...existingLines];
        for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === undefined) continue;
            const formatted = formatFrontmatterLine(key, value);
            const existingIdx = existingMap.get(key);
            if (existingIdx !== undefined) {
                newFrontmatterLines[existingIdx] = formatted;
            } else {
                newFrontmatterLines.push(formatted);
            }
        }
        const newFrontmatter = `---\n${newFrontmatterLines.join('\n')}\n---\n`;
        return content.replace(frontmatterRegex, () => newFrontmatter);
    }

    const newFrontmatterLines: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
        if (value !== null && value !== undefined) {
            newFrontmatterLines.push(formatFrontmatterLine(key, value));
        }
    }
    const newFrontmatter = `---\n${newFrontmatterLines.join('\n')}\n---\n\n`;
    return newFrontmatter + content;
}

function formatFrontmatterLine(key: string, value: unknown): string {
    if (value === '') return `${key}: ""`;
    if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('"'))) {
        return `${key}: "${value.replace(/"/g, '\\"')}"`;
    }
    return `${key}: ${value}`;
}
