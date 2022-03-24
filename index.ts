import * as dotenv from 'dotenv';

import { ApolloClient, InMemoryCache, gql, HttpLink, NormalizedCacheObject } from '@apollo/client'
import { BatchHttpLink } from "@apollo/client/link/batch-http";
import { assert } from 'chai';

import fetch from "cross-fetch";
import fetchRetry from "fetch-retry";
import { ethers } from 'ethers';

import * as math from 'mathjs';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const PROMISE_BATCH_SIZE = 300;


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



const START_BLOCK = 26208359 - 604800/2;
const END_BLOCK = 26208359;

const APIURL = 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-v2';
const BLOCKSAPIURL = 'https://api.thegraph.com/subgraphs/name/dynamic-amm/ethereum-blocks-polygon';


const range = (start: number, end: number) => Array.from(Array(end - start + 1).keys()).map(x => x + start);

async function getBlocksFast(client: ApolloClient<NormalizedCacheObject>, start:number, end:number, pageSize:number = 100) {
    let results: any[] = [];
    let promises: any[] = [];
    let finishedPromises: any[] = [];

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


async function getSwapsOrJoinsTs(type: string, client: ApolloClient<NormalizedCacheObject>, poolId: string, minTimestamp: string, maxTimestamp: string, pageSize: number): Promise<number[]> {
    let results: number[] = [];
    let page = 0;
    
    let lastId = "";

    while (true) {
        const q = `{
            ${type}(where: {pool${type === 'swaps' ? 'Id' : ''}: "${poolId}", timestamp_gte: ${minTimestamp}, timestamp_lt: ${maxTimestamp}, id_gt: "${lastId}"}, first: ${pageSize}, orderBy: id, orderDirection: asc) {
                timestamp,
                id
            }
        }`;
        
        const d = await client.query({query: gql(q)});
        
        
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

async function getSwapsTimestamps2(client: ApolloClient<NormalizedCacheObject>, poolId: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
    return getSwapsOrJoinsTs('swaps', client, poolId, minTimestamp, maxTimestamp, pageSize);
}

async function getJoinExitTimestamps2(client: ApolloClient<NormalizedCacheObject>, poolId: string, minTimestamp: string, maxTimestamp: string, pageSize: number = 100): Promise<number[]> {
    return getSwapsOrJoinsTs('joinExits', client, poolId, minTimestamp, maxTimestamp, pageSize);
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

    // const promises: any[] = blocks.map(b => {
    //     return new Promise(async (resolve, reject) => {
    //         const q = `{
    //             pools(where: {id: "${poolId}"}, block: { number: ${b} }) {
    //                 totalLiquidity,
    //                 totalShares
    //             }
    //         }`;

    //         const y = (await client.query({query: gql(q)})).data.pools[0];
            
    //         const yCopy = JSON.parse(JSON.stringify(y));
    //         yCopy.block = b;

    //         console.log('liquidity progress:', currentPage / blocks.length);
    //         currentPage++;
            
    //         resolve(yCopy);
    //     })
    // });

    let promises2: any[] = [];
    let awaitedPromises: any[] = [];
    for (let i = 0; i < blocks.length; i++) {
        promises2.push(new Promise(async (resolve, reject) => {
            const q = `{
                pools(where: {id: "${poolId}"}, block: { number: ${blocks[i]} }) {
                    totalLiquidity,
                    totalShares
                }
            }`;

            const y = (await client.query({query: gql(q)})).data.pools[0];
            
            const yCopy = JSON.parse(JSON.stringify(y));
            yCopy.block = blocks[i];

            console.log('liquidity progress:', currentPage / blocks.length);
            currentPage++;
            
            resolve(yCopy);
        }));

        if (promises2.length === PROMISE_BATCH_SIZE) {
            awaitedPromises = awaitedPromises.concat(await Promise.all(promises2));
            promises2 = [];
        }
    }

    return awaitedPromises.concat(await Promise.all(promises2));
}

/////////////////////////////////////////////////////////////


async function calculateV(balancerClient: ApolloClient<NormalizedCacheObject>, blocksClient: ApolloClient<NormalizedCacheObject>, poolId: string): Promise<number[]> {
    /*
    
    PLAN:
    
    get block <-> timestamp for relevant period of time - done
    get all swaps - done
    get all join/exits - done
    get liquidity data for all blocks with swaps,joins, or exits - done
    fill in V, using above data - done
    
    
    */

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
        poolId, 
        blockToTimestamp[START_BLOCK], 
        blockToTimestamp[END_BLOCK]
    );
    
    // get joins/exits
    const joinExitTimestamps = await getJoinExitTimestamps2(
        balancerClient, 
        poolId, 
        blockToTimestamp[START_BLOCK], 
        blockToTimestamp[END_BLOCK]
    );

    // get blocks of interactions with pool (swap/join/exit)
    const blocksOfInteraction: number[] = joinExitTimestamps.map(x => parseInt(timestampToBlock[x])).concat(swapTimestamps.map(x => parseInt(timestampToBlock[x])));

    // test to make sure that pool.totalLiquidity ONLY changes at these blocks
    // it works
    /*
    let lastLiq = '';
    for (let b = START_BLOCK; b < END_BLOCK; b++) {
        const res = await getLiquidityAtBlock(balancerClient, POOL_ID, b.toString());
        console.log(b, res.totalLiquidity, blocksOfInteraction.indexOf(b) != -1);
        if (lastLiq !== '' && res.totalLiquidity !== lastLiq && blocksOfInteraction.indexOf(b) === -1) {
            console.log(b);
        }
        lastLiq = res.totalLiquidity;
    }
    */
    
    // get liquidity data for all blocks with interactions
    const liquidityData = await getLiquidityForListOfBlocks(balancerClient, poolId, blocksOfInteraction);
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

    const initialLiquidity = await getLiquidityAtBlock(balancerClient, poolId, START_BLOCK);
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

    return _V;
}

async function getERC20TransferEvents(
    erc20Address: string,
    startBlock = 0,
    endBlock = 9999999999999
): Promise<{[key: string]: string}[]> {
    const URL = `https://api.polygonscan.com/api?module=account&action=tokentx&contractaddress=${erc20Address}&startblock=${startBlock}&endblock=${endBlock}&sort=asc&apikey=${process.env.POLYGONSCAN_API_KEY}`;

    const data = await fetch(URL).then((x) => x.json());

    if (data.result.length === 10000) {
        throw new Error("hit 10k erc20 transfer limit");
    }

    return data.result;
}; 

async function calculateS(poolTokenAddress: string) {
    /*
    PLAN

    fetch ALL erc20 transfers of LP token up until END_BLOCK

    recreate balances of all users at START_BLOCK by iterating over transfers
        - pause once START_BLOCK is reached

    use above balances to create first column of _S

    continue iteration over transfers
        - fill in columns between last filled column and current block's column with values of last filled in column (because state is unchanged during these blocks)
        - set column corresponding to current transfer block to current balances state

    return

    */
    const transfers = await getERC20TransferEvents(poolTokenAddress, 0, END_BLOCK);

    const addresses: string[] = []; // this array also keeps track of which row is which
    const balances: {[key: string]: any} = {};

    function updateBalances(tx: {[key: string]: string}) {
        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();
        const value = ethers.BigNumber.from(tx.value);
        
        if (from !== ZERO_ADDRESS) {
            balances[from] = balances[from] || ethers.BigNumber.from(0);
            balances[from] = balances[from].sub(value);
            if (addresses.indexOf(from) === -1) {
                addresses.push(from);
            }
        }
        
        if (to !== ZERO_ADDRESS) {
            balances[to] = balances[to] || ethers.BigNumber.from(0);   
            balances[to] = balances[to].add(value);
            if (addresses.indexOf(to) === -1) {
                addresses.push(to);
            }
        }
    }
    
    let i = 0;
    while (parseInt(transfers[i].blockNumber) <= START_BLOCK) {
        const tx = transfers[i];
        updateBalances(tx);
        i++;
    }

    const _S: any[][] = Array(addresses.length).fill([]);

    // create initial column
    for (let j = 0; j < addresses.length; j++) {
        _S[j] = [balances[addresses[j]]];
    }

    while (i < transfers.length && parseInt(transfers[i].blockNumber) < END_BLOCK) {
        const tx = transfers[i];
        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();
        const blockNo = parseInt(tx.blockNumber);
        
        updateBalances(tx);

        const nCols = _S[0].length;

        if (blockNo - START_BLOCK > nCols) {
            // we need to fill in columns with repeated data
            let numberToFill = blockNo - START_BLOCK - nCols;

            // iterate over rows
            for (let _row = 0; _row < _S.length; _row++) {
                // fill in extra data for each column until we hit current block
                _S[_row] = _S[_row].concat(Array(numberToFill).fill(_S[_row][nCols - 1]));
            }
        }

        assert(_S.length === addresses.length || _S.length === addresses.length - 1);

        // if there was a new address added then we add a new row on the bottom of _S with zeros
        if (addresses.length - 1 === _S.length) {
            const numberToFill = blockNo - START_BLOCK;
            _S.push(Array(numberToFill).fill(ethers.BigNumber.from(0)));
        }

        assert(_S.length === addresses.length);
        // finally, add a new column with current balances

        for (let iAddr = 0; iAddr < addresses.length; iAddr++) {
            _S[iAddr].push(balances[addresses[iAddr]]);
        }

        // assert that the new column is legit

        console.log(i/transfers.length);

        i++;
    }

    const nCols = _S[0].length;

    if (END_BLOCK - START_BLOCK > nCols) {
        // we need to fill in columns with repeated data
        let numberToFill = END_BLOCK - START_BLOCK - nCols;

        // iterate over rows
        for (let _row = 0; _row < _S.length; _row++) {
            // fill in extra data for each column until we hit current block
            _S[_row] = _S[_row].concat(Array(numberToFill).fill(_S[_row][nCols - 1]));
        }
    }

    console.log('casting to js number')
    for (let i = 0; i < _S.length; i++) {
        assert(_S[0].length === _S[i].length);
        for (let j = 0; j < _S[0].length; j++) {
            _S[i][j] = _S[i][j] - 0;
        }
    }

    return _S;
}

(async () => {
    // TODO: maybe use BigNumber for _V calculation - not sure if floating point error will become problematic
    // TODO: use the graph or blockchain-etl for erc20 transfers - the 10K transfer limit could be a future issue if this is used long-term

    const SCRIPT_START_TS = Date.now();

    // create graphql clients
    const balancerClient = new ApolloClient({
        link: new HttpLink({ uri: APIURL, fetch: customFetch }),
        cache: new InMemoryCache()
    });

    const blocksClient = new ApolloClient({
        link: new HttpLink({ uri: BLOCKSAPIURL, fetch: customFetch }),
        cache: new InMemoryCache()
    });

    const POOL_ID = "0xdb1db6e248d7bb4175f6e5a382d0a03fe3dcc813000100000000000000000035";
    const POOL_ADDRESS = "0xdB1db6E248d7Bb4175f6E5A382d0A03fe3DCc813";

    // calculate _V
    const _V = await calculateV(balancerClient, blocksClient, POOL_ID);

    // calculate _S
    const _S = await calculateS(POOL_ADDRESS);
    assert(_S[0].length === END_BLOCK - START_BLOCK);

    // calculate _Yp = _S*_V := sum of liquidity at each block for each user (USD)
    const _Yp = math.multiply(math.matrix(_S), math.matrix(_V));

    console.log(_Yp);



    console.log(`finished in ${Math.floor((Date.now() - SCRIPT_START_TS)/1000)} seconds`);
})();