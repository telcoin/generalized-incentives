import fetch from "cross-fetch";
import fetchRetry from "fetch-retry";
import { ApolloClient, HttpLink, InMemoryCache, NormalizedCacheObject, ApolloQueryResult, gql } from "@apollo/client";
import { HistoricalTokenValue } from "./types";
import { consoleReplaceLine, decimalToPercent, shortenAddress } from "../helpers/misc";

const customFetch = fetchRetry(fetch, {
    retries: 5
});

const BALANCERAPIURL = 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-v2';
const BLOCKSAPIURL = 'https://api.thegraph.com/subgraphs/name/dynamic-amm/ethereum-blocks-polygon';

const PROMISE_BATCH_SIZE = 150;


// create graphql clients
const balancerClient = new ApolloClient({
    link: new HttpLink({ uri: BALANCERAPIURL, fetch: customFetch }),
    cache: new InMemoryCache()
});

const blocksClient = new ApolloClient({
    link: new HttpLink({ uri: BLOCKSAPIURL, fetch: customFetch }),
    cache: new InMemoryCache()
});

export async function getBlocks(start:number, end:number, pageSize:number = 100) {
    let results: any[] = [];
    let promises: Promise<ApolloQueryResult<any>>[] = [];
    let finishedPromises: ApolloQueryResult<any>[] = [];

    let currentPage = 1;
    const numPages = Math.ceil((end - start + 1)/pageSize);
    
    let lastPct = 0;
    
    process.stdout.write('fetch blocks progress: 0%');

    for (let a = start; a <= end; a += pageSize) {
        const q = `{
            blocks(where: {number_gte: ${a}, number_lt: ${a+pageSize}}, orderBy: number, orderDirection: asc) {
                number
                timestamp
            }
        }`;

        promises.push(new Promise(async (resolve, reject) => {
            const y = await blocksClient.query({query: gql(q), fetchPolicy: 'no-cache'});
            
            const currPct = decimalToPercent(currentPage / numPages);
            
            if (currPct > lastPct) {
                consoleReplaceLine(`fetch blocks progress: ${currPct}%`);
                lastPct = currPct;
            }

            currentPage++;
            resolve(y);
        }));

        if (promises.length === PROMISE_BATCH_SIZE) {
            finishedPromises = finishedPromises.concat(await Promise.all(promises));
            promises = [];
        }
    }
    
    finishedPromises = finishedPromises.concat(await Promise.all(promises));
    
    finishedPromises.forEach(r => {
        results = results.concat(r.data.blocks);
    });

    console.log();

    return results;
}

async function getDataPaginatedById<ReturnType>(
    client: ApolloClient<NormalizedCacheObject>,
    arrayName: string,
    queryStringFunction: (id: string) => string,
    processResponseFunction: (data: any) => ReturnType[]
): Promise<ReturnType[]> {
    let results: ReturnType[] = [];
    let lastId = "";

    while (true) {
        const q = queryStringFunction(lastId);

        const res = await client.query({query: gql(q), fetchPolicy: 'no-cache'});

        if (res.data[arrayName].length === 0) {
            results.sort();
            return results;
        }
        
        results = results.concat(processResponseFunction(res.data));

        lastId = res.data[arrayName][res.data[arrayName].length - 1].id;
    }
}


export async function getSwapsTimestampsBalancer(poolAddress: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
    let page = 0;
    const poolId = await getBalancerPoolIdFromAddress(poolAddress);
    const shortenedAddress = shortenAddress(poolAddress);
    
    function createQueryString(id: string) {
        return `{
            swaps(where: {poolId: "${poolId}", timestamp_gte: ${minTimestamp}, timestamp_lt: ${maxTimestamp}, id_gt: "${id}"}, first: ${pageSize}, orderBy: id, orderDirection: asc) {
                timestamp,
                id
            }
        }`;
    }

    function processResponse(data: any): number[] {
        page++;
        consoleReplaceLine(`fetch swaps for ${shortenedAddress} page: ${page}/?`);
        return data.swaps.map((x:any) => parseInt(x.timestamp));
    }
    
    process.stdout.write(`fetch swaps for ${shortenedAddress} page: 0/?`)

    const result = await getDataPaginatedById<number>(balancerClient, "swaps", createQueryString, processResponse);
    console.log();
    return result;
}

export async function getJoinExitTimestampsBalancer(poolAddress: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
    let page = 0;
    const poolId = await getBalancerPoolIdFromAddress(poolAddress);
    const shortenedAddress = shortenAddress(poolAddress);

    function createQueryString(id: string) {
        return `{
            joinExits(where: {pool: "${poolId}", timestamp_gte: ${minTimestamp}, timestamp_lt: ${maxTimestamp}, id_gt: "${id}"}, first: ${pageSize}, orderBy: id, orderDirection: asc) {
                timestamp,
                id
            }
        }`;
    }

    function processResponse(data: any): number[] {
        page++;
        consoleReplaceLine(`fetch joins/exits for ${shortenedAddress} page: ${page}/?`);
        return data.joinExits.map((x:any) => parseInt(x.timestamp));
    }
    
    process.stdout.write(`fetch joins/exits for ${shortenedAddress} page: 0/?`);

    const result = await getDataPaginatedById<number>(balancerClient, "joinExits", createQueryString, processResponse);
    console.log();
    return result;
}

export async function getLpTokenValueAtBlockBalancer(poolAddress: string, block: number): Promise<number> {
    const poolId = await getBalancerPoolIdFromAddress(poolAddress);

    const q = `{
        pools(where: {id: "${poolId}"}, block: { number: ${block} }) {
            totalLiquidity,
            totalShares
        }
    }`;

    const y = (await balancerClient.query({query: gql(q), fetchPolicy: 'no-cache'})).data.pools[0];
    
    return Number(y.totalLiquidity) / Number(y.totalShares);
}

export async function getHistoricalLpTokenValuesBalancer(poolAddress: string, blocks: number[]): Promise<HistoricalTokenValue[]> {
    let currentPage = 1;
    const poolId = await getBalancerPoolIdFromAddress(poolAddress);
    const shortenedAddress = shortenAddress(poolAddress);
    
    function buildQueryString(params: {[key:string]:string}): string {
        return `{
            pools(where: {id: "${poolId}"}, block: { number: ${params.block} }) {
                totalLiquidity,
                totalShares
            }
        }`;
    }

    let lastPct = 0;
    function processResponse(params: {[key:string]:string}, data: any): HistoricalTokenValue {
        const currPct = decimalToPercent(currentPage / blocks.length);
        if (currPct > lastPct) {
            consoleReplaceLine(`fetch liquidity for ${shortenedAddress} progress: ${currPct}%`);
            lastPct = currPct;
        }
        currentPage++;

        return {
            block: Number(params.block),
            value: Number(data.pools[0].totalLiquidity) / Number(data.pools[0].totalShares)
        };
    }
    const params = blocks.map(block => {return {block: block.toString()}});

    process.stdout.write(`fetch liquidity for ${shortenedAddress} progress: 0%`);

    const result = await batchQueries(balancerClient, params, buildQueryString, processResponse);
    console.log();
    return result;
}

async function batchQueries<ReturnType>(
    client: ApolloClient<NormalizedCacheObject>, 
    paramsArray: {[key:string]:string}[], 
    queryStringFunction: (params: {[key:string]:string}) => string, 
    processResponseFunction: (params: {[key:string]:string}, data: any) => ReturnType
): Promise<ReturnType[]> {
    let promises: Promise<ReturnType>[] = [];
    let awaited: ReturnType[] = [];
    for (let i = 0; i < paramsArray.length; i++) {
        const p = paramsArray[i];
        
        promises.push(new Promise(async (resolve, reject) => {
            const qs = queryStringFunction(p);
            const response = await client.query({query: gql(qs), fetchPolicy: 'no-cache'});

            resolve(processResponseFunction(p, response.data));
        }));
        
        if (promises.length === PROMISE_BATCH_SIZE) {
            awaited = awaited.concat(await Promise.all(promises));
            promises = [];
        }
    }

    return awaited.concat(await Promise.all(promises));
}

async function getBalancerPoolIdFromAddress(address: string): Promise<string> {
    const q = `{
        pools(where: {address: "${address}"}) {
            id
        }
    }`
    const res = await balancerClient.query({query: gql(q), fetchPolicy: 'no-cache'});
    return res.data.pools[0].id;
}