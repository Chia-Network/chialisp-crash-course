import {
    PrivateKey,
    fromHex,
    AugSchemeMPL,
    concatBytes,
} from '@rigidity/bls-signatures';
import { mnemonicToSeedSync } from 'bip39';
import dotenv from 'dotenv';
import { Program } from '@rigidity/clvm';
import fs from 'fs';
import path from 'path';
import { FullNode, formatHex, SpendBundle, toCoinId } from '@rigidity/chia';
import { KeyStore, StandardWallet } from '@rigidity/chia-wallet';
import os from 'os';

dotenv.config();

const mnemonic = process.env.MNEMONIC;

const program = Program.deserializeHex(
    fs.readFileSync(path.join(__dirname, '..', 'signature.clsp.hex'), 'utf-8')
);

const privateKey = PrivateKey.fromSeed(mnemonicToSeedSync(mnemonic!));
const publicKey = privateKey.getG1();
const curried = program.curry([Program.fromJacobianPoint(publicKey)]);

const node = new FullNode(os.homedir() + '/.chia/mainnet');
const keyStore = new KeyStore(privateKey);

const wallet = new StandardWallet(node, keyStore);
const genesis = fromHex(process.env.GENESIS!);

async function create() {
    await wallet.sync({ unusedAddressCount: 10 });

    const spend = wallet.createSpend();
    spend.coin_spends = await wallet.send(curried.hash(), 0.01e12, 0.00005e12);
    wallet.signSpend(spend, genesis);
    console.log(await node.pushTx(spend));
}

async function spend() {
    await wallet.sync({ unusedAddressCount: 10 });

    const coinRecords = await node.getCoinRecordsByPuzzleHash(
        curried.hashHex()
    );
    if (!coinRecords.success) throw new Error(coinRecords.error);

    const record = coinRecords.coin_records[0];

    console.log(record);

    // Calculate an unused address we can send the value to.
    const [targetIndex] = await wallet.findUnusedIndices(1, []);
    const target = wallet.puzzleCache[targetIndex];

    // A fee of 0.00005 XCH.
    const fee = 0.00005e12;

    // Create a coin on the target, leaving a fee to be sent to the farmer.
    const conditions = Program.fromSource(
        `((51 ${formatHex(target.hashHex())} ${record.coin.amount - fee}))`
    );

    // Create a solution from the conditions.
    const solution = Program.fromSource(`(${conditions})`).serializeHex();

    const signature = AugSchemeMPL.sign(
        privateKey,
        concatBytes(conditions.hash(), toCoinId(record.coin), genesis)
    ).toHex();

    const spendBundle: SpendBundle = {
        coin_spends: [
            {
                coin: record.coin,
                puzzle_reveal: curried.serializeHex(),
                solution: solution,
            },
        ],
        aggregated_signature: signature,
    };

    console.log(await node.pushTx(spendBundle));
}

spend();
