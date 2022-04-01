import fetch from "cross-fetch";
import fetchRetry from "fetch-retry";
import { ApolloClient, HttpLink, InMemoryCache, NormalizedCacheObject, ApolloQueryResult, gql } from "@apollo/client";
import { HistoricalTokenValue } from "./types";

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
    
    for (let a = start; a <= end; a += pageSize) {
        const q = `{
            blocks(where: {number_gte: ${a}, number_lt: ${a+pageSize}}, orderBy: number, orderDirection: asc) {
                number
                timestamp
            }
        }`;

        promises.push(new Promise(async (resolve, reject) => {
            const y = await blocksClient.query({query: gql(q)});
            console.log('block progress:', currentPage / numPages);
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

    return results;
}

async function getSwapsOrJoinsTsBalancer(type: string, poolAddress: string, minTimestamp: string, maxTimestamp: string, pageSize: number): Promise<number[]> {
    let results: number[] = [];
    let page = 0;
    
    let lastId = "";

    const poolId = await getPoolIdFromAddress(poolAddress);
    
    while (true) {
        const q = `{
            ${type}(where: {pool${type === 'swaps' ? 'Id' : ''}: "${poolId}", timestamp_gte: ${minTimestamp}, timestamp_lt: ${maxTimestamp}, id_gt: "${lastId}"}, first: ${pageSize}, orderBy: id, orderDirection: asc) {
                timestamp,
                id
            }
        }`;
        
        const d = await balancerClient.query({query: gql(q)});
        
        
        console.log(`${type} page:`, page);
        page++;
        
        results = results.concat(d.data[type].map((x: any) => x.timestamp));
        
        if (d.data[type].length < pageSize) {
            results.sort();
            return results;
        }

        lastId = d.data[type][d.data[type].length - 1].id;
    }
}

export async function getSwapsTimestampsBalancer(poolAddress: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
    return getSwapsOrJoinsTsBalancer('swaps', poolAddress, minTimestamp, maxTimestamp, pageSize);
}

export async function getJoinExitTimestampsBalancer(poolAddress: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
    return getSwapsOrJoinsTsBalancer('joinExits', poolAddress, minTimestamp, maxTimestamp, pageSize);
}

export async function getLpTokenValueAtBlockBalancer(poolAddress: string, block: number): Promise<number> {
    const poolId = await getPoolIdFromAddress(poolAddress);

    const q = `{
        pools(where: {id: "${poolId}"}, block: { number: ${block} }) {
            totalLiquidity,
            totalShares
        }
    }`;

    const y = (await balancerClient.query({query: gql(q)})).data.pools[0];
    
    return Number(y.totalLiquidity) / Number(y.totalShares);
}

export async function getHistoricalLpTokenValuesBalancer(poolAddress: string, blocks: number[]): Promise<HistoricalTokenValue[]> {
    const poolId = await getPoolIdFromAddress(poolAddress);
    
    let currentPage = 1;

    let promises2: Promise<HistoricalTokenValue>[] = [];
    let awaitedPromises: HistoricalTokenValue[] = [];
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        promises2.push(new Promise(async (resolve, reject) => {
            const q = `{
                pools(where: {id: "${poolId}"}, block: { number: ${block} }) {
                    totalLiquidity,
                    totalShares
                }
            }`;

            const y = (await balancerClient.query({query: gql(q)})).data.pools[0];

            console.log('liquidity progress:', currentPage / blocks.length);
            currentPage++;
            
            resolve({
                block: block,
                value: Number(y.totalLiquidity) / Number(y.totalShares)
            });
        }));

        if (promises2.length === PROMISE_BATCH_SIZE) {
            awaitedPromises = awaitedPromises.concat(await Promise.all(promises2));
            promises2 = [];
        }
    }

    return awaitedPromises.concat(await Promise.all(promises2));
}

// TODO: abstract this away from main index.ts file, it should do this fetch in here
// async function getPoolIdsFromAddresses(addresses: string[]): Promise<{[key: string]: string}> {
//     const poolIds: {[key: string]: string} = {};
    
//     await Promise.all(addresses.map(async poolAddr => {
//         const q = `{
//             pools(where: {address: "${poolAddr}"}) {
//                 id
//             }
//         }`
//         const res = await balancerClient.query({query: gql(q)});
//         poolIds[poolAddr] = res.data.pools[0].id;
//     }));

//     return poolIds;
// }

async function getPoolIdFromAddress(address: string): Promise<string> {
    const q = `{
        pools(where: {address: "${address}"}) {
            id
        }
    }`
    const res = await balancerClient.query({query: gql(q)});
    return res.data.pools[0].id;
}