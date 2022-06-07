import fetch from "cross-fetch";

const APIURL = "https://api.polygonscan.com/api?apikey=" + process.env.POLYGONSCANKEY + "&";

const tsToNumCache: {[key:number]: number} = {};

export async function getBlockNumberByTimestamp(ts: number): Promise<number> {
    if (tsToNumCache[ts]) {
        return tsToNumCache[ts];
    }

    const res = await fetch(APIURL + `module=block&action=getblocknobytime&timestamp=${ts}&closest=before`);
    const resJson = await res.json();

    tsToNumCache[ts] = Number(resJson.result);

    return tsToNumCache[ts];
}
