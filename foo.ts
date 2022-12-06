import * as dotenv from 'dotenv';
dotenv.config();

import * as alchemy from './api/alchemy';


(async () => {
    const swaps = await alchemy.getSwaps('0x0297E37F1873D2DAB4487AA67CD56B58E2F27875000100000000000000000002', 16388321);
    console.log(swaps.length);
    console.log(new Set(swaps.map(s => s.transactionHash + s.logIndex)).size);
})();