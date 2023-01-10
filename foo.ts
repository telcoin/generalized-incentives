import * as dotenv from 'dotenv';
import { BigNumber } from 'ethers';
import {assert, expect} from 'chai';
dotenv.config();

import * as alchemy from './api/alchemy';

const TEL = "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32".toLowerCase();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

async function getReserves(fromBlock: number, toBlock: number) {
    assert(toBlock > fromBlock);

    // get swaps
    const swaps = await alchemy.getBalancerSwaps('0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000034', fromBlock, toBlock);
    // get joinexits
    const joinExits = await alchemy.getBalancerJoinExits('0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000034', fromBlock, toBlock);

    const reservesDeltas: {[key: number]: BigNumber} = {}; // block -> delta
    
    swaps.forEach(swap => {
        const blockNumber = swap.blockNumber;
        if (reservesDeltas[blockNumber] === undefined) {
            reservesDeltas[blockNumber] = BigNumber.from(0);
        }

        // insert something into deltas
        if (swap.tokenIn === TEL) {
            reservesDeltas[blockNumber] = reservesDeltas[blockNumber].add(swap.amountIn);
        }
        else if (swap.tokenOut === TEL) {
            reservesDeltas[blockNumber] = reservesDeltas[blockNumber].sub(swap.amountOut);
        }
    });

    joinExits.forEach(joinExit => {
        // insert something into deltas
        const blockNumber = joinExit.blockNumber;
        if (reservesDeltas[blockNumber] === undefined) {
            reservesDeltas[blockNumber] = BigNumber.from(0);
        }

        const telIndex = joinExit.tokens.indexOf(TEL);
        
        assert(telIndex >= 0 && telIndex < 2 && typeof telIndex == 'number');

        reservesDeltas[blockNumber] = reservesDeltas[blockNumber].add(joinExit.deltas[telIndex]);
        reservesDeltas[blockNumber] = reservesDeltas[blockNumber].sub(joinExit.protocolFeeAmounts[telIndex]);
    
    });

    // create telReserves vector
    const telReserves: BigNumber[] = [await getReservesAtBlock(fromBlock)];

    // start i at 1 because we have the initial liquidity in _V already
    for (let i = 1; i < toBlock - fromBlock; i++) {
        telReserves.push(telReserves[telReserves.length - 1]); // duplicate last element

        if (reservesDeltas[fromBlock + i] !== undefined) {
            telReserves[i] = telReserves[i].add(reservesDeltas[fromBlock + i]);
        }
    }

    return telReserves;
}

async function getLptSupplies(fromBlock: number, toBlock: number) {
    assert(toBlock > fromBlock);

    const lptSupplyDeltas: {[key: number]: BigNumber} = {}; // block -> delta

    const mints = await alchemy.getTransfers('0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56', fromBlock, toBlock, {fromAddress: ZERO_ADDRESS});
    const burns = await alchemy.getTransfers('0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56', fromBlock, toBlock, {toAddress: ZERO_ADDRESS});

    mints.concat(burns).forEach(mintBurn => {
        const blockNumber = Number(mintBurn.blockNum);
        if (lptSupplyDeltas[blockNumber] === undefined) {
            lptSupplyDeltas[blockNumber] = BigNumber.from(0);
        }

        if (mintBurn.from == ZERO_ADDRESS) {
            // mint
            lptSupplyDeltas[blockNumber] = lptSupplyDeltas[blockNumber].add(mintBurn.rawContract.value);
        }
        else {
            // burn
            lptSupplyDeltas[blockNumber] = lptSupplyDeltas[blockNumber].sub(mintBurn.rawContract.value);
        }
    });

    // create telReserves vector
    const lptSupplies: BigNumber[] = [await balancerContracts.getLptSupplyAtBlock('0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56', fromBlock)];

    // start i at 1 because we have the initial liquidity in _V already
    for (let i = 1; i < toBlock - fromBlock; i++) {
        lptSupplies.push(lptSupplies[lptSupplies.length - 1]); // duplicate last element

        if (lptSupplyDeltas[fromBlock + i] !== undefined) {
            lptSupplies[i] = lptSupplies[i].add(lptSupplyDeltas[fromBlock + i]);
        }
    }

    return lptSupplies;
}

async function calculateVBalancer2(fromBlock: number, toBlock: number) {
    const telReserves = getReserves(fromBlock, toBlock);


    // console.log(deltas)

    // create LPT supply vector (similarly TODO need to get initial lpt supply and set as first element in array)

    // _V = telReserves/lptSupply
}
import * as balancerContracts from './api/balancerContracts';

async function getReservesAtBlock(blockNumber: number) {
    return balancerContracts.getTelInPoolAtBlock('0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56', blockNumber);
}

(async () => {
    const startBlock = 36419162;
    const endBlock = 36512538;
    const a = await getReserves(startBlock, endBlock);
    const b = await getReservesAtBlock(endBlock);
    console.log(a, b, a[a.length-1]?.sub(b));
    console.log(a.length, endBlock - startBlock);

    const lpts = await getLptSupplies(startBlock, endBlock);
    console.log(await balancerContracts.getLptSupplyAtBlock('0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56', endBlock), lpts[lpts.length - 1]);
})();