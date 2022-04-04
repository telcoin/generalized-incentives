export function shortenAddress(address: string): string {
    return address.substring(0, 6) + '...' + address.substring(address.length - 4);
}

export function decimalToPercent(d: number): number {
    return Math.floor(d*100);
}

export function consoleReplaceLine(s: string) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(s);
}