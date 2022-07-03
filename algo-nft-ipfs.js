const fs = require('fs');
const path = require('path');
const algosdk = require('algosdk');
const bs58 = require('bs58');

require('dotenv').config()
const assetMetadata = require('./assetMetadata');

const algodClient = new algosdk.Algodv2(
  process.env.algodClientToken,
  process.env.algodClientUrl,
  process.env.algodClientPort
);

const indexerClient = new algosdk.Indexer(
  process.env.indexerToken,
  process.env.indexerUrl,
  process.env.indexerPort
);

const pinataApiKey = process.env.pinataApiKey;
const pinataApiSecret = process.env.pinataApiSecret;
const pinataSdk = require('@pinata/sdk');
const pinata = pinataSdk(pinataApiKey, pinataApiSecret);

const keypress = async () => {
  process.stdin.setRawMode(true);
  return new Promise(resolve => process.stdin.once('data', () => {
    process.stdin.setRawMode(false)
    resolve()
  }));
};

const waitForConfirmation = async (txId) => {
  const status = await algodClient.status().do();
  let lastRound = status["last-round"];
  let txInfo = null;

  while (true) {
    txInfo = await algodClient.pendingTransactionInformation(txId).do();
    if (txInfo["confirmed-round"] !== null && txInfo["confirmed-round"] > 0) {
      console.log("Transaction " + txId + " confirmed in round " + txInfo["confirmed-round"]);
      break;
    }
    lastRound ++;
    await algodClient.statusAfterBlock(lastRound).do();
  }

  return txInfo;
}

const createAccount = () => {
  try {
    const mnemonic = process.env.mnemonic
    const account = algosdk.mnemonicToSecretKey(mnemonic);

    console.log("Derived account address = " + account.addr);
    console.log("To add funds to the account, visit https://dispenser.testnet.aws.algodev.network/?account=" + account.addr);

    return account;
  }
  catch (err) {
    console.log("err", err);
  }
};

const ipfsHash = (cid) => {
  const cidUint8Arr = bs58.decode(cid).slice(2);
  const cidBase64 = cidUint8Arr.toString('base64');
  return { cidUint8Arr, cidBase64 };
};

const assetPinnedToIpfs = async (nftFilePath, mimeType, assetName, assetDesc) => {
  const nftFile = fs.createReadStream(nftFilePath);
  const nftFileName = nftFilePath.split('/').pop();
  
  const properties = {
    "file_url": nftFileName,
    "file_url_integrity": "",
    "file_url_mimetype": mimeType
  };

  const pinMeta = {
    pinataMetadata: {
      name: assetName,
      keyvalues: {
        "url": nftFileName,
        "mimetype": mimeType
      }
    },
    pinataOptions: {
      cidVersion: 0
    }
  };

  const resultFile = await pinata.pinFileToIPFS(nftFile, pinMeta);
  console.log('Asset pinned to IPFS via Pinata: ', resultFile);

  let metadata = assetMetadata.arc3MetadataJson;

  const integrity = ipfsHash(resultFile.IpfsHash);

  metadata.name = `${assetName}@arc3`;
  metadata.description = assetDesc;
  metadata.image = `ipfs://${resultFile.IpfsHash}`;
  metadata.image_integrity = `${integrity.cidBase64}`;
  metadata.image_mimetype = mimeType;
  metadata.properties = properties;
  metadata.properties.file_url = `https://ipfs.io/ipfs/${resultFile.IpfsHash}`;
  metadata.properties.file_url_integrity = `${integrity.cidBase64}`;

  console.log('Algorand NFT-IPFS metadata: ', metadata);

  const resultMeta = await pinata.pinJSONToIPFS(metadata, pinMeta);
  const metaIntegrity = ipfsHash(resultMeta.IpfsHash);
  console.log('Asset metadata pinned to IPFS via Pinata: ', resultMeta);

  return {
    name: `${assetName}@arc3`,
    url: `ipfs://${resultMeta.IpfsHash}`,
    metadata: metaIntegrity.cidUint8Arr,
    integrity: metaIntegrity.cidBase64
  };
};

const createAssetOnIpfs = async () => {
  return await pinata.testAuthentication().then((res) => {
    console.log('Pinata test authentication: ', res);
    return assetPinnedToIpfs(
      'smiley-ninja-896x896.jpg',
      'image/jpeg',
      'Ninja Smiley',
      'Ninja Smiley 896x896 JPEG image pinned to IPFS'
    );
  }).catch((err) => {
    return console.log(err);
  });
}

const createArc3Asset = async (asset, account) => {
  (async () => {
    let acct = await indexerClient.lookupAccountByID(account.addr).do();
    console.log("Account Address: " + acct['account']['address']);
    console.log("         Amount: " + acct['account']['amount']);
    console.log("        Rewards: " + acct['account']['rewards']);
    console.log(" Created Assets: " + acct['account']['total-created-assets']);
    console.log("  Current Round: " + acct['current-round']);
  })().catch(e => {
    console.error(e);
    console.trace();
  });

  const txParams = await algodClient.getTransactionParams().do();

  const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    from: account.addr,
    total: 1,
    decimals: 0,
    defaultFrozen: false,
    manager: account.addr,
    reserve: undefined,
    freeze: undefined,
    clawback: undefined,
    unitName: 'nft',
    assetName: asset.name,
    assetURL: asset.url,
    assetMetadataHash: new Uint8Array(asset.metadata),
    suggestedParams: txParams
  });

  const rawSignedTxn = txn.signTxn(account.sk);
  const tx = await algodClient.sendRawTransaction(rawSignedTxn).do();

  // const confirmedTxn = await algosdk.waitForConfirmation(algodClient, tx, 4);
  // /* Error: Transaction not confirmed after 4 rounds */
  const confirmedTxn = await waitForConfirmation(tx.txId);
  const txInfo = await algodClient.pendingTransactionInformation(tx.txId).do();

  const assetID = txInfo["asset-index"];

  console.log('Account ', account.addr, ' has created ARC3 compliant NFT with asset ID', assetID);
  console.log(`Check it out at https://testnet.algoexplorer.io/asset/${assetID}`);

  return { assetID };
}

const createNft = async () => {
  try {
    let account = createAccount();

    console.log("Press any key when the account is funded ...");
    await keypress();

    const asset = await createAssetOnIpfs();

    const { assetID } = await createArc3Asset(asset, account);
  }
  catch (err) {
    console.log("err", err);
  };

  process.exit();
};

createNft();

