import * as dotenv from 'dotenv';
dotenv.config();

import { assert } from 'chai';

import fetch from "cross-fetch";
import fetchRetry from "fetch-retry";
import { ethers } from 'ethers';

import * as math from 'mathjs';

import * as alchemy from './api/alchemy';
import { HistoricalTokenValue, Transfer } from './api/types';

import * as graph from './api/graph';
import { testS, testVBalancer } from './helpers/testingHelper';


const POOLS = [
    {
        symbol: "TEL/BAL/USDC",
        address: "0xdB1db6E248d7Bb4175f6E5A382d0A03fe3DCc813".toLowerCase(),
        protocol: "balancer"
    },
    {
        symbol: "TEL/BAL",
        address: "0x186084fF790C65088BA694Df11758faE4943EE9E".toLowerCase(),
        protocol: "balancer"
    },
    // {
    //     symbol: "TEL/QUICK",
    //     address: "0xe88e24f49338f974b528ace10350ac4576c5c8a1".toLowerCase(),
    //     protocol: "quickswap"
    // }
];

const START_BLOCK = 26548163 - 604800/2;
const END_BLOCK = 26548163;

const INCENTIVES = 20000000;

const DIVERSITY_BASE_MULTIPLIER = 0.5;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

/////////////////////////////////////////////////////////////

function calculateVFromData(liquidityData: HistoricalTokenValue[], liquidityValueAtStartBlock: number, startBlock: number, endBlock: number): number[] {
    liquidityData.sort((a, b) => {
        return a.block - b.block;
    })

    // make sure it is in ascending block order
    for (let i = 0; i < liquidityData.length-1; i++) {
        assert(liquidityData[i].block <= liquidityData[i+1].block);
    }

    // fill in V - this is the vector of liquidity share value at each block, where the index is the block - START_BLOCK
    let _V: number[] = [];

    _V = Array(liquidityData[0].block - startBlock).fill(liquidityValueAtStartBlock);

    for (let i = 0; i < liquidityData.length - 1; i++) {
        const liq0 = liquidityData[i];
        const liq1 = liquidityData[i+1];
        _V = _V.concat(Array(liq1.block - liq0.block).fill(liq0.value));
    }

    const liqf = liquidityData[liquidityData.length - 1];
    _V = _V.concat(Array(endBlock - liqf.block).fill(liqf.value));

    assert(_V.length === endBlock - startBlock);

    return _V;
}

async function calculateVBalancer(poolAddress: string, startBlock: number, endBlock: number): Promise<number[]> {
    // to get liquidity data, we first need to get blocks where swaps, adds, or removeds occur
    // get swaps
    const swapTimestamps = await graph.getSwapsTimestampsBalancer(
        poolAddress, 
        blockNumberToTimestamp[startBlock], 
        blockNumberToTimestamp[endBlock]
    );
    
    // get joins/exits
    const joinExitTimestamps = await graph.getJoinExitTimestampsBalancer(
        poolAddress, 
        blockNumberToTimestamp[startBlock], 
        blockNumberToTimestamp[endBlock]
    );

    // get blocks of interactions with pool (swap/join/exit)
    let blocksOfInteraction: number[] = joinExitTimestamps.map(x => parseInt(blockTimestampToNumber[x])).concat(swapTimestamps.map(x => parseInt(blockTimestampToNumber[x])));

    // remove potential duplicates
    blocksOfInteraction = [...new Set(blocksOfInteraction)];

    const liquidityData = await graph.getHistoricalLpTokenValuesBalancer(poolAddress, blocksOfInteraction);
    assert(liquidityData.length === blocksOfInteraction.length);

    const initialLiquidity = await graph.getLpTokenValueAtBlockBalancer(poolAddress, startBlock);

    return calculateVFromData(liquidityData, initialLiquidity, startBlock, endBlock);
}

async function calculateS(transfers: Transfer[], addresses: string[]) {
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

    const balances: {[key: string]: ethers.BigNumber} = {};

    function updateBalances(tx: Transfer) {
        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();
        const value = ethers.BigNumber.from(tx.rawContract.value);

        if (value.eq('0')) {
            return;
        }
        
        if (from !== ZERO_ADDRESS) {
            balances[from] = balances[from].sub(value);
            assert(balances[from].gte('0'));
            assert(addresses.indexOf(from) !== -1);
        }
        
        if (to !== ZERO_ADDRESS) {
            balances[to] = balances[to] || ethers.BigNumber.from('0');   
            balances[to] = balances[to].add(value);
            assert(addresses.indexOf(to) !== -1);
        }
    }
    
    let i = 0;
    while (parseInt(transfers[i].blockNum) <= START_BLOCK) {
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

    while (i < transfers.length && parseInt(transfers[i].blockNum) < END_BLOCK) {
        const tx = transfers[i];
        const blockNo = parseInt(tx.blockNum);
        
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


function getAllUserAddressesFromTransfers(transfers: Transfer[]): string[] {
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
    const blocks = await graph.getBlocks(START_BLOCK, END_BLOCK);  

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

    // get all erc20 transfer data
    const erc20TransfersByPool = await alchemy.getTransfersOfPools(POOLS.map(p => p.address), 0, END_BLOCK);

    // build master list of users
    const allUserAddresses = getAllUserAddressesFromTransfers(Array.prototype.concat(...Object.values(erc20TransfersByPool)));

    // create mapping between block timestamp and number
    await createBlockMapping();

    const yVecPerPool: {[key: string]: math.Matrix} = {};

    for (let i = 0; i < POOLS.length; i++) {
        const pool = POOLS[i];
        // calculate _V
        let _V: number[];
        if (pool.protocol === "balancer") {
            _V = await calculateVBalancer(pool.address, START_BLOCK, END_BLOCK);
            await testVBalancer(_V, pool.address, START_BLOCK, END_BLOCK);
        }
        else {
            throw new Error("Invalid protocol");
        }
    
        // calculate _S
        const _S = await calculateS(erc20TransfersByPool[pool.address], allUserAddresses);
        await testS(_S, allUserAddresses, pool.address, START_BLOCK, END_BLOCK);
    
        // calculate _Yp = _S*_V := sum of liquidity at each block for each user (USD)
        const _Yp = math.multiply(math.matrix(_S), math.matrix(_V));
        assert(_Yp.size()[0] === allUserAddresses.length);

        yVecPerPool[pool.address] = _Yp;
    }

    // create diversity multiplier vectors
    const dVecPerPool = calculateDiversityMultiplierFromYVecs(yVecPerPool);

    // calculate _F (with diversity boost)
    let _F = math.zeros(Object.values(yVecPerPool)[0].size());
    for (let i = 0; i < POOLS.length; i++) {
        const _Yp = yVecPerPool[POOLS[i].address];
        const _Dp = dVecPerPool[POOLS[i].address];
        _F = math.add(_F, math.dotMultiply(_Yp, _Dp)) as math.Matrix;
    }

    const normalizedF = math.multiply(1 / math.sum(_F), _F);
    const calculatedIncentives = math.multiply(INCENTIVES, normalizedF) as math.Matrix;
    
    console.log('filling data took', TIMING.fillingData.total);

    console.log(`finished in ${Math.floor((Date.now() - TIMING.scriptStart)/1000)} seconds`);

    // idea for diversity multiplier: for each pool A, go through each other pool B. the multiplier on A is SUM( max(1, Yb/Ya)*1.5 ) over B
})();