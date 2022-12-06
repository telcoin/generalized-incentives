import fetch from "cross-fetch";
import { AlchemyBlockResponse, AlchemyTransfersParameters, AlchemyTransfersResponse, Param, Transfer } from "./types";

const KEY = process.env.ALCHEMYKEY;
const APIURL = "https://polygon-mainnet.g.alchemy.com/v2/" + KEY;

import { Network, Alchemy } from "alchemy-sdk";
import { AbiCoder } from "ethers/lib/utils";

// Optional config object, but defaults to demo api-key and eth-mainnet.
const settings = {
    apiKey: process.env.ALCHEMYKEY, // Replace with your Alchemy API Key.
    network: Network.MATIC_MAINNET, // Replace with your network.
  };
const alchemy = new Alchemy(settings);

export async function getEvents(address: string, topics: string[], fromBlock: number, toBlock: number) {
    let events: any[] = [];

    let from = fromBlock;
    let to = toBlock;
    while (true) {
        try {
            const unboundedTry = await alchemy.core.getLogs({
                address,
                topics,
                fromBlock: from,
                toBlock: to
            });

            
            // it succeeded, add to events array and step forward
            
            // add to events
            events = events.concat(unboundedTry);

            // if to == toBlock, we're done. return
            if (to === toBlock) {
                return events;
            }

            // we've got from-to, so set from = to, to = toBlock and try again
            from = to + 1;
            to = toBlock;
        }
        catch (e) {
            const errorResponse = JSON.parse((e as any).body);

            if (!errorResponse.error || errorResponse.error.code != -32602) {
                throw e;
            }

            // use the suggested block range
            const rangeStr = errorResponse.error.message.split('this block range should work: ')[1].replace('[','').replace(']','').replace(' ','');

            const lower = Number(rangeStr.split(',')[0]);
            const upper = Number(rangeStr.split(',')[1]);

            console.log(lower, upper);

            // limit endblock in order to continue
            to = upper;
        }

    }
}

export function getSwaps(poolId: string, fromBlock: number, toBlock: number) {
    const topics = [
        '0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b', // Swap(...) hash
        poolId
    ];

    return getEvents('0xBA12222222228d8Ba445958a75a0704d566BF2C8', topics, fromBlock, toBlock);
}

export function getJoinExits(poolId: string, fromBlock: number, toBlock: number) {
    const topics = [
        '0xe5ce249087ce04f05a957192435400fd97868dba0e6a4b4c049abf8af80dae78', // PoolBalanceChanged(...) hash
        poolId
    ];

    return getEvents('0xBA12222222228d8Ba445958a75a0704d566BF2C8', topics, fromBlock, toBlock);
}

export async function getTransfers(erc20Address: string, startblock: number, endBlock: number, additionalOptions: Param = {}): Promise<Transfer[]> {
    if (endBlock === -1) {
        endBlock = await getTopBlockNumber();
    }
    
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

async function getTopBlockNumber(): Promise<number> {
    const body = {
        "jsonrpc":"2.0",
        "method":"eth_blockNumber",
        "params":[],
        "id":0
    };

    const opts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "follow"
    } as RequestInit;

    const response = await fetch(APIURL, opts);
    const resJson = await response.json() as AlchemyBlockResponse;

    return Number(resJson.result);
}
