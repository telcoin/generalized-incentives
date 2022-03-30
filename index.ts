import * as dotenv from 'dotenv';

import { ApolloClient, InMemoryCache, gql, HttpLink, NormalizedCacheObject, ApolloQueryResult } from '@apollo/client'
import { BatchHttpLink } from "@apollo/client/link/batch-http";
import { assert } from 'chai';

import fetch from "cross-fetch";
import fetchRetry from "fetch-retry";
import { ethers } from 'ethers';

import * as math from 'mathjs';
import * as dfd from "danfojs-node"

dotenv.config();

const POOLS = [
    "0xdB1db6E248d7Bb4175f6E5A382d0A03fe3DCc813".toLowerCase(), // tel/bal/usdc
    "0x186084fF790C65088BA694Df11758faE4943EE9E".toLowerCase() // tel/bal
];

const START_BLOCK = 26548163 - 604800/20;
const END_BLOCK = 26548163;

const INCENTIVES = 20000000;

const DIVERSITY_BASE_MULTIPLIER = 0.5;

const PROMISE_BATCH_SIZE = 150;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const BALANCERAPIURL = 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-v2';
const BLOCKSAPIURL = 'https://api.thegraph.com/subgraphs/name/dynamic-amm/ethereum-blocks-polygon';

type Transaction = {[key: string]: string};

const blockTimestampToNumber: {[key: string]: string} = {}
const blockNumberToTimestamp: {[key: string]: string} = {}

const TIMING = {
    scriptStart: 0,
    fetchBlocks: {
        start: 0,
        end: 0
    },
    fetchSwaps: {},
    fetchJoinExits: {},
    fetchLiquidity: {},
    fillingData: {
        last: 0,
        total: 0
    },
    casting: {
        start: 0,
        end: 0
    }
};

const customFetch = fetchRetry(fetch, {
    retries: 5
});


const range = (start: number, end: number) => Array.from(Array(end - start + 1).keys()).map(x => x + start);

async function getBlocksFast(client: ApolloClient<NormalizedCacheObject>, start:number, end:number, pageSize:number = 100) {
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

    let promises2: Promise<any>[] = [];
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


async function calculateV(balancerClient: ApolloClient<NormalizedCacheObject>, poolId: string): Promise<number[]> {
    /*
    
    PLAN:
    
    get all swaps - done
    get all join/exits - done
    get liquidity data for all blocks with swaps,joins, or exits - done
    fill in V, using above data - done
    
    
    */

    // get swaps
    const swapTimestamps = await getSwapsTimestamps2(
        balancerClient, 
        poolId, 
        blockNumberToTimestamp[START_BLOCK], 
        blockNumberToTimestamp[END_BLOCK]
    );
    
    // get joins/exits
    const joinExitTimestamps = await getJoinExitTimestamps2(
        balancerClient, 
        poolId, 
        blockNumberToTimestamp[START_BLOCK], 
        blockNumberToTimestamp[END_BLOCK]
    );

    // get blocks of interactions with pool (swap/join/exit)
    let blocksOfInteraction: number[] = joinExitTimestamps.map(x => parseInt(blockTimestampToNumber[x])).concat(swapTimestamps.map(x => parseInt(blockTimestampToNumber[x])));

    // remove potential duplicates
    blocksOfInteraction = [...new Set(blocksOfInteraction)];

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
): Promise<Transaction[]> {
    const URL = `https://api.polygonscan.com/api?module=account&action=tokentx&contractaddress=${erc20Address}&startblock=${startBlock}&endblock=${endBlock}&sort=asc&apikey=${process.env.POLYGONSCAN_API_KEY}`;

    const data = await fetch(URL).then((x) => x.json());

    if (data.result.length === 10000) {
        throw new Error("hit 10k erc20 transfer limit");
    }

    return data.result;
}; 

async function calculateS(transfers: Transaction[], addresses: string[]) {
    /*
    PLAN

    recreate balances of all users at START_BLOCK by iterating over transfers
        - pause once START_BLOCK is reached

    use above balances to create first column of _S

    continue iteration over transfers
        - fill in columns between last filled column and current block's column with values of last filled in column (because state is unchanged during these blocks)
        - set column corresponding to current transfer block to current balances state

    return

    */
    // const transfers = await getERC20TransferEvents(poolTokenAddress, 0, END_BLOCK);

    // const addresses: string[] = []; // this array also keeps track of which row is which
    const balances: {[key: string]: bigint} = {};

    function updateBalances(tx: Transaction) {
        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();
        const value = ethers.BigNumber.from(tx.value).toBigInt();

        if (value === BigInt(0)) {
            return;
        }
        
        if (from !== ZERO_ADDRESS) {
            balances[from] -= value;
            assert(balances[from] >= BigInt(0));
            assert(addresses.indexOf(from) !== -1);
        }
        
        if (to !== ZERO_ADDRESS) {
            balances[to] = balances[to] || BigInt(0);   
            balances[to] += value;
            assert(addresses.indexOf(to) !== -1);
        }
    }
    
    let i = 0;
    while (parseInt(transfers[i].blockNumber) <= START_BLOCK) {
        const tx = transfers[i];
        updateBalances(tx);
        i++;
    }

    const _S: number[][] = Array(addresses.length).fill([]);

    function fillColumns(numberToFill: number) {
        TIMING.fillingData.last = Date.now();
        const nCols = _S[0].length;
        // iterate over rows
        for (let _row = 0; _row < _S.length; _row++) {
            // fill in extra data for each column until we hit current block
            const v = _S[_row][nCols - 1];
            for (let _n = 0; _n < numberToFill; _n++) {
                _S[_row].push(v)
            }
        }
        TIMING.fillingData.total += Date.now() - TIMING.fillingData.last;
    }


    // create initial column
    for (let j = 0; j < addresses.length; j++) {
        _S[j] = [Number(balances[addresses[j]] || 0)];
    }

    while (i < transfers.length && parseInt(transfers[i].blockNumber) < END_BLOCK) {
        const tx = transfers[i];
        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();
        const blockNo = parseInt(tx.blockNumber);
        
        updateBalances(tx);

        const nCols = _S[0].length;
        if (blockNo - START_BLOCK > nCols) {
            fillColumns(blockNo - START_BLOCK - nCols);
        }

        // finally, add a new column with current balances

        for (let iAddr = 0; iAddr < addresses.length; iAddr++) {
            _S[iAddr].push(Number(balances[addresses[iAddr]] || 0));
        }

        // assert that the new column is legit

        console.log(i/transfers.length);

        i++;
    }

    const nCols = _S[0].length;
    if (END_BLOCK - START_BLOCK > nCols) {
        fillColumns(END_BLOCK - START_BLOCK - nCols);
    }


    return _S;
}

async function getPoolIdsFromAddresses(balancerClient: ApolloClient<NormalizedCacheObject>, addresses: string[]): Promise<{[key: string]: string}> {
    const poolIds: {[key: string]: string} = {};
    
    await Promise.all(addresses.map(async poolAddr => {
        const q = `{
            pools(where: {address: "${poolAddr}"}) {
                id
            }
        }`
        const res = await balancerClient.query({query: gql(q)});
        poolIds[poolAddr] = res.data.pools[0].id;
    }));

    return poolIds;
}

async function getERC20TransferEventsOfPools(pools: string[]): Promise<{ [key: string]: Transaction[] }> {
    const erc20TransfersByPool: {[key: string]: Transaction[]} = {};

    await Promise.all(pools.map(async poolAddr => {
        erc20TransfersByPool[poolAddr] = await getERC20TransferEvents(poolAddr, 0, END_BLOCK);
    }));

    return erc20TransfersByPool;
}

function getAllUserAddressesFromTransfers(transfers: Transaction[]): string[] {
    const addrs: string[] = [];
    transfers.forEach(tx => {
        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();

        if (from !== ZERO_ADDRESS && addrs.indexOf(from) === -1) {
            addrs.push(from);
        }
        if (to !== ZERO_ADDRESS && addrs.indexOf(to) === -1) {
            addrs.push(to);
        }
    });
    return addrs;
}

async function createBlockMapping() {
    const blocksClient = new ApolloClient({
        link: new HttpLink({ uri: BLOCKSAPIURL, fetch: customFetch }),
        cache: new InMemoryCache()
    });

    const blocks = await getBlocksFast(blocksClient, START_BLOCK, END_BLOCK);  

    blocks.forEach(x => {
        blockTimestampToNumber[x.timestamp] = x.number;
        blockNumberToTimestamp[x.number] = x.timestamp;
    });

}

function calculateDiversityMultiplierFromYVecs(yVecPerPool: {[key: string]: math.Matrix}): {[key: string]: math.Matrix} {
    const mVecPerPool: {[key: string]: math.Matrix} = {}; // holds Mp per pool
    const pools = Object.keys(yVecPerPool);
    for (let i = 0; i < pools.length; i++) {
        const _Yx = yVecPerPool[pools[i]];
        let _Mp = math.zeros(_Yx.size());
        // summation term
        for (let j = 0; j < pools.length; j++) {
            if (i === j) continue;
            let inner = math.dotDivide(yVecPerPool[pools[j]], _Yx) as math.Matrix;
            inner = inner.map(v => v === Infinity || isNaN(v) ? 0 : v);
            inner = inner.map(v => math.min(1, v));
            _Mp = math.add(_Mp, inner);
        }

        _Mp = math.multiply(DIVERSITY_BASE_MULTIPLIER, _Mp) as math.Matrix;

        _Mp = math.add(1, _Mp) as math.Matrix;

        mVecPerPool[pools[i]] = _Mp;
    }

    return mVecPerPool;
}

(async () => {
    // TODO: maybe use BigNumber for _V calculation - not sure if floating point error will become problematic
    // TODO: use the graph or blockchain-etl for erc20 transfers - the 10K transfer limit could be a future issue if this is used long-term

    TIMING.scriptStart = Date.now();

    // create graphql clients
    const balancerClient = new ApolloClient({
        link: new HttpLink({ uri: BALANCERAPIURL, fetch: customFetch }),
        cache: new InMemoryCache()
    });

    const poolIds = await getPoolIdsFromAddresses(balancerClient, POOLS);

    // get all erc20 transfer data
    const erc20TransfersByPool = await getERC20TransferEventsOfPools(POOLS);

    // build master list of users
    const allUserAddresses = getAllUserAddressesFromTransfers(Array.prototype.concat(...Object.values(erc20TransfersByPool)));

    // create mapping between block timestamp and number
    await createBlockMapping();

    const yVecPerPool: {[key: string]: math.Matrix} = {};

    for (let i = 0; i < POOLS.length; i++) {
        // calculate _V
        const _V = await calculateV(balancerClient, poolIds[POOLS[i]]);
        assert(_V.length === END_BLOCK - START_BLOCK);
    
        // calculate _S
        const _S = await calculateS(erc20TransfersByPool[POOLS[i]], allUserAddresses);
        assert(_S[0].length === END_BLOCK - START_BLOCK);
        assert(_S.length === allUserAddresses.length);
    
        // calculate _Yp = _S*_V := sum of liquidity at each block for each user (USD)
        const _Yp = math.multiply(math.matrix(_S), math.matrix(_V));
        assert(_Yp.size()[0] === allUserAddresses.length);

        yVecPerPool[POOLS[i]] = _Yp;
    }

    // create diversity multiplier vectors
    const dVecPerPool = calculateDiversityMultiplierFromYVecs(yVecPerPool);
    console.log(dVecPerPool);

    const aa = dVecPerPool[POOLS[0]].toArray();
    const bb = dVecPerPool[POOLS[1]].toArray();
    for (let i = 0; i < allUserAddresses.length; i++) {

        if (aa[i] !== 1 || bb[i] !== 1) {
            console.log(aa[i], bb[i]);
            console.log(yVecPerPool[POOLS[0]].toArray()[i], yVecPerPool[POOLS[1]].toArray()[i]);
            console.log(allUserAddresses[i]);
            continue;
        }
    }

    return;
    

    // calculate _F (with diversity boost)
    let _F = math.zeros(yVecPerPool[POOLS[0]].size());
    for (let i = 0; i < POOLS.length; i++) {
        const _Yp = yVecPerPool[POOLS[i]];
        const _Dp = dVecPerPool[POOLS[i]];
        _F = math.add(_F, math.dotMultiply(_Yp, _Dp)) as math.Matrix;
    }

    const normalizedF = math.multiply(1 / math.sum(_F), _F);
    const calculatedIncentives = math.multiply(INCENTIVES, normalizedF);
    
    console.log('filling data took', TIMING.fillingData.total);

    console.log(`finished in ${Math.floor((Date.now() - TIMING.scriptStart)/1000)} seconds`);

    // idea for diversity multiplier: for each pool A, go through each other pool B. the multiplier on A is SUM( max(1, Yb/Ya)*1.5 ) over B
})();