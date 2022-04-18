import fetch from "cross-fetch";
import { AlchemyTransfersParameters, AlchemyTransfersResponse, Param, Transfer } from "./types";

const KEY = process.env.ALCHEMYKEY;
const APIURL = "https://polygon-mainnet.g.alchemy.com/v2/" + KEY;

export async function getTransfers(erc20Address: string, startblock: number, endBlock: number, additionalOptions: Param = {}): Promise<Transfer[]> {
    const body = {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "alchemy_getAssetTransfers",
        "params": [
            {
                "fromBlock": '0x' + startblock.toString(16),
                "toBlock": '0x' + (endBlock).toString(16),
                //   "fromAddress": "0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE",
                "contractAddresses": [erc20Address],
                // "maxCount": "0x5",
                "excludeZeroValue": true,
                "category": ["erc20"]
            }
        ]
    } as AlchemyTransfersParameters;

    body.params[0] = Object.assign(body.params[0], additionalOptions);

    let ans: Transfer[] = [];

    while (true) {
        const opts = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            redirect: "follow"
        } as RequestInit;

        const response = await fetch(APIURL, opts);
        const resJson = await response.json() as AlchemyTransfersResponse;

        resJson.result.transfers.forEach(tx => {
            tx.from = tx.from.toLowerCase();
            tx.to = tx.to.toLowerCase();
            tx.rawContract.address = tx.rawContract.address.toLowerCase();
            ans.push(tx);
        })

        if (resJson.result.pageKey === undefined) {
            return ans;
        }
        
        body.params[0].pageKey = resJson.result.pageKey;
    }
}

export async function getTransfersOfPools(erc20Addresses: string[], startBlock: number, endBlock: number): Promise<{[key: string]: Transfer[]}> {
    const ans: {[key: string]: Transfer[]} = {};

    for (let i = 0; i < erc20Addresses.length; i++) {
        ans[erc20Addresses[i]] = await getTransfers(erc20Addresses[i], startBlock, endBlock);
    }

    return ans;
}
