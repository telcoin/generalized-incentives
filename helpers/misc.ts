export function shortenAddress(address: string, caps: boolean = false): string {
    const x = address.substring(2, 6) + '..' + address.substring(address.length - 4);
    return '0x'+ (caps ? x.toUpperCase() : x.toLowerCase());
}

export function decimalToPercent(d: number): number {
    return Math.floor(d*100);
}

export function truncateDecimal(d: number, points: number): number {
    const x = Math.pow(10, points)
    return Math.floor(d * x) / x;
}

export function consoleReplaceLine(s: string) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    console.log(s);
}

export function wait(ms: number) {
    return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, ms);
    })
}