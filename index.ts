const SCRIPT_START_TS = Date.now();

import { ApolloClient, InMemoryCache, gql, HttpLink, NormalizedCacheObject } from '@apollo/client'
import { BatchHttpLink } from "@apollo/client/link/batch-http";
import { assert } from 'chai';

import fetch from "cross-fetch";
import fetchRetry from "fetch-retry";


const TIMING = {
    fetchBlocks: {
        start: 0,
        end: 0
    },
    fetchSwaps: {},
    fetchJoinExits: {},
    fetchLiquidity: {}
};

const customFetch = fetchRetry(fetch, {
    retries: 100
});



const START_BLOCK = 26208359 - 100000;//604800/20;
const END_BLOCK = 26208359;

const APIURL = 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-v2';
const BLOCKSAPIURL = 'https://api.thegraph.com/subgraphs/name/dynamic-amm/ethereum-blocks-polygon';


const range = (start: number, end: number) => Array.from(Array(end - start + 1).keys()).map(x => x + start);


// async function getBlocks(client: ApolloClient<NormalizedCacheObject>, start:number, end:number, pageSize:number = 100): Promise<{[key: string]: string}[]> {
//     let results: any[] = [];
//     for (let a = start; a < end; a += pageSize) {
//         const q = `{
//             blocks(where: {number_gte: ${a}, number_lt: ${a+pageSize}}, orderBy: number, orderDirection: asc) {
//                 number
//                 timestamp
//             }
//         }`;
//         const d = await client.query({query: gql(q)});
//         console.log('block progress:', (a - start)/(end - start));
//         results = results.concat(d.data.blocks);
//     }
//     return results;
// }

async function getBlocksFast(client: ApolloClient<NormalizedCacheObject>, start:number, end:number, pageSize:number = 100) {
    let results: any[] = [];
    const promises: any[] = [];

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
            const y = await client.query({query: gql(q)});
            console.log('block progress:', currentPage / numPages);
            currentPage++;
            resolve(y);
        }));
    }

    const allResults = await Promise.all(promises);
    
    allResults.forEach(r => {
        results = results.concat(r.data.blocks);
    });

    return results;
}

// async function getSwapsTimestamps(client: ApolloClient<NormalizedCacheObject>, poolId: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
//     let results: number[] = [];
//     let page = 0;
//     console.log(minTimestamp, maxTimestamp);
//     while (true) {
//         const q = `{
//             swaps(where: {poolId: "${poolId}", timestamp_gte: ${minTimestamp}, timestamp_lt: ${maxTimestamp}}, first: ${pageSize}, orderBy: timestamp, orderDirection: asc, skip: ${page*pageSize}) {
//                 timestamp,
//                 id
//             }
//         }`;
        
//         const d = await client.query({query: gql(q)});
        
//         console.log('swap page:', page);
//         page++;
        
//         results = results.concat(d.data.swaps.map((x: any) => x.timestamp));

//         if (d.data.swaps.length < pageSize) {
//             return results;
//         }
//     }
// }

async function getSwapsTimestamps2(client: ApolloClient<NormalizedCacheObject>, poolId: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
    let results: number[] = [];
    let page = 0;
    
    let lastId = "";

    while (true) {
        const q = `{
            swaps(where: {poolId: "${poolId}", timestamp_gte: ${minTimestamp}, timestamp_lt: ${maxTimestamp}, id_gt: "${lastId}"}, first: ${pageSize}, orderBy: id, orderDirection: asc) {
                timestamp,
                id
            }
        }`;
        
        const d = await client.query({query: gql(q)});
        
        
        console.log('swap page:', page);
        page++;
        
        results = results.concat(d.data.swaps.map((x: any) => x.timestamp));
        
        if (d.data.swaps.length < pageSize) {
            results.sort();
            return results;
        }

        lastId = d.data.swaps[d.data.swaps.length - 1].id;
    }
}

// async function getJoinExitTimestamps(client: ApolloClient<NormalizedCacheObject>, poolId: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
//     let results: number[] = [];
//     let page = 0;

//     while (true) {
//         const q = `{
//             joinExits(where: {pool: "${poolId}", timestamp_gte: ${minTimestamp}, timestamp_lt: ${maxTimestamp}}, first: ${pageSize}, orderBy: timestamp, orderDirection: asc, skip: ${page*pageSize}) {
//                 timestamp
//             }
//         }`;
        
//         const d = await client.query({query: gql(q)});
        
//         console.log('joinexit page:', page);
//         page++;
        
//         results = results.concat(d.data.joinExits.map((x: any) => x.timestamp));

//         if (d.data.joinExits.length < pageSize) {
//             return results;
//         }
//     }
// }

async function getJoinExitTimestamps2(client: ApolloClient<NormalizedCacheObject>, poolId: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
    let results: number[] = [];
    let page = 0;
    
    let lastId = "";

    while (true) {
        const q = `{
            joinExits(where: {pool: "${poolId}", timestamp_gte: ${minTimestamp}, timestamp_lt: ${maxTimestamp}, id_gt: "${lastId}"}, first: ${pageSize}, orderBy: id, orderDirection: asc) {
                timestamp,
                id
            }
        }`;
        
        const d = await client.query({query: gql(q)});
        
        console.log('joinexit page:', page);
        page++;
        
        results = results.concat(d.data.joinExits.map((x: any) => x.timestamp));
        
        if (d.data.joinExits.length < pageSize) {
            results.sort();
            return results;
        }

        lastId = d.data.joinExits[d.data.joinExits.length - 1].id;
    }
}

async function getLiquidityAtBlock(client: ApolloClient<NormalizedCacheObject>, poolId: string, block: number) {
    const q = `{
        pools(where: {id: "${poolId}"}, block: { number: ${block} }) {
            totalLiquidity,
            totalShares
        }
    }`;

    const y = (await client.query({query: gql(q)})).data.pools[0];
            
    const yCopy = JSON.parse(JSON.stringify(y));
    yCopy.block = block;
    return yCopy;
}

async function getLiquidityForListOfBlocks(client: ApolloClient<NormalizedCacheObject>, poolId: string, blocks: number[]) {
    let currentPage = 1;

    const promises: any[] = blocks.map(b => {
        return new Promise(async (resolve, reject) => {
            const q = `{
                pools(where: {id: "${poolId}"}, block: { number: ${b} }) {
                    totalLiquidity,
                    totalShares
                }
            }`;

            const y = (await client.query({query: gql(q)})).data.pools[0];
            
            const yCopy = JSON.parse(JSON.stringify(y));
            yCopy.block = b;

            console.log('liquidity progress:', currentPage / blocks.length);
            currentPage++;
            
            resolve(yCopy);
        })
    });

    return Promise.all(promises);
}



(async () => {

    /*
    
    PLAN:
    
    get block <-> timestamp for relevant period of time - done
    get all swaps - done
    get all join/exits - done
    get liquidity data for all blocks with swaps,joins, or exits - done
    fill in V, using above data
    
    
    */
    
    const POOL_ID = "0x03cd191f589d12b0582a99808cf19851e468e6b500010000000000000000000a";

    const balancerClient = new ApolloClient({
        link: new HttpLink({ uri: APIURL, fetch: customFetch }),
        cache: new InMemoryCache()
    });


    // get block <-> timestamp
    const blocksClient = new ApolloClient({
        link: new HttpLink({ uri: BLOCKSAPIURL, fetch: customFetch }),
        cache: new InMemoryCache()
    });

    const timestampToBlock: {[key: string]: string} = {}
    const blockToTimestamp: {[key: string]: string} = {}
    if (true) {
        const blocks = await getBlocksFast(blocksClient, START_BLOCK, END_BLOCK);  

        blocks.forEach(x => {
            timestampToBlock[x.timestamp] = x.number;
            blockToTimestamp[x.number] = x.timestamp;
        });
    }

    // get swaps
    const swapTimestamps = await getSwapsTimestamps2(
        balancerClient, 
        POOL_ID, 
        blockToTimestamp[START_BLOCK], 
        blockToTimestamp[END_BLOCK]
    );
    
    // get joins/exits
    const joinExitTimestamps = await getJoinExitTimestamps2(
        balancerClient, 
        POOL_ID, 
        blockToTimestamp[START_BLOCK], 
        blockToTimestamp[END_BLOCK]
    );

    // get blocks of interactions with pool (swap/join/exit)
    const blocksOfInteraction: number[] = joinExitTimestamps.map(x => parseInt(timestampToBlock[x])).concat(swapTimestamps.map(x => parseInt(timestampToBlock[x])));

    // test to make sure that pool.totalLiquidity ONLY changes at these blocks
    // it works
    // let lastLiq = '';
    // for (let b = START_BLOCK; b < END_BLOCK; b++) {
    //     const res = await getLiquidityAtBlock(balancerClient, POOL_ID, b.toString());
    //     console.log(b, res.totalLiquidity, blocksOfInteraction.indexOf(b) != -1);
    //     if (lastLiq !== '' && res.totalLiquidity !== lastLiq && blocksOfInteraction.indexOf(b) === -1) {
    //         console.log(b);
    //     }
    //     lastLiq = res.totalLiquidity;
    // }

    
    // get liquidity data for all blocks with interactions
    const liquidityData = await getLiquidityForListOfBlocks(balancerClient, POOL_ID, blocksOfInteraction);
    assert(liquidityData.length === blocksOfInteraction.length);

    liquidityData.sort((a, b) => {
        return a.block - b.block;
    })

    // make sure it is in ascending block order
    for (let i = 0; i < liquidityData.length-1; i++) {
        assert(liquidityData[i].block <= liquidityData[i+1].block);
    }

    // fill in V - this is the vector of liquidity share value at each block, where the index is the block - START_BLOCK
    let _V: number[] = [];

    const initialLiquidity = await getLiquidityAtBlock(balancerClient, POOL_ID, START_BLOCK);
    _V = Array(liquidityData[0].block - START_BLOCK).fill(initialLiquidity.totalLiquidity / initialLiquidity.totalShares);

    for (let i = 0; i < liquidityData.length - 1; i++) {
        const liq0 = liquidityData[i];
        const liq1 = liquidityData[i+1];
        const val = liq0.totalLiquidity / liq0.totalShares;

        _V = _V.concat(Array(liq1.block - liq0.block).fill(val));
    }

    const liqf = liquidityData[liquidityData.length - 1];
    _V = _V.concat(Array(END_BLOCK - liqf.block).fill(liqf.totalLiquidity / liqf.totalShares));

    assert(_V.length === END_BLOCK - START_BLOCK);
    

    






    console.log(`finished in ${Math.floor((Date.now() - SCRIPT_START_TS)/1000)} seconds`);
})();