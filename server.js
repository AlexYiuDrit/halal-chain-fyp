const express = require('express');
const Web3 = require('web3').default;
const path = require('path');
const { MongoClient, ServerApiVersion } = require('mongodb');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = 3000;

// --- Configuration ---
const ganacheUrl = process.env.GANACHE_URL;
const web3 = new Web3(ganacheUrl);

const mongoUri = process.env.MONGO_URI;
const dbName = 'halalCertDb';
const collectionName = 'certificates';

const mongoClient = new MongoClient(mongoUri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    }
  });

let db, certificatesCollection;
async function connectDb() {
    try {
        // Connect the client to the server
        await mongoClient.connect();
        db = mongoClient.db(dbName);
        certificatesCollection = db.collection(collectionName);
        console.log(`Successfully connected to MongoDB Atlas! Database: ${dbName}, Collection: ${collectionName}`);

        // Optional: You could add a ping here if you want confirmation on startup
        // await db.command({ ping: 1 });
        // console.log("Ping successful.");

    } catch (err) {
        console.error('!!! Failed to connect to MongoDB Atlas:', err);
        // Try to close client gracefully on connection error during startup
        await mongoClient.close();
        process.exit(1); // Exit if DB connection fails
    }
    // DO NOT close the client here in a long-running server
}

// --- Web3 Contract Instance Setup ---
let halalContract;
let contractAddress;

try {
    const contractJson = require('./build/contracts/HalalCertificate.json');
    const contractABI = contractJson.abi;

    // Dynamically find the address from the most recent deployment in the artifact
    // This assumes Ganache network ID ('*') or a known ID like 5777 is in the networks object
    const networkId = Object.keys(contractJson.networks)[Object.keys(contractJson.networks).length - 1]; // Get the last deployed network ID key
    const deployedNetwork = contractJson.networks[networkId];

    if (!deployedNetwork || !deployedNetwork.address) {
         throw new Error("Contract address not found in build artifact. Ensure contract is deployed.");
    }
    contractAddress = deployedNetwork.address; // Assign the dynamically found address

    console.log(`Dynamically loaded contract address: ${contractAddress}`);
    halalContract = new web3.eth.Contract(contractABI, contractAddress);
    console.log(`Contract instance created for address: ${contractAddress}`);

} catch (error) {
    console.error("!!! Error setting up contract instance:", error);
    process.exit(1);
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(__dirname));

// --- Helper Function for Hashing ---
function calculateHash(data) {
    // Create a consistent string representation (e.g., sorted JSON) for hashing
    const orderedData = JSON.stringify(Object.keys(data).sort().reduce(
      (obj, key) => {
        obj[key] = data[key];
        return obj;
      },
      {}
    ));
    return '0x' + crypto.createHash('sha256').update(orderedData).digest('hex');
}

// --- API Endpoints ---

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// MODIFIED Endpoint: Add/Update Certificate (Hybrid)
app.post('/addCertificate', async (req, res) => {
    if (!certificatesCollection) {
         return res.status(503).send({ success: false, message: 'Database not connected yet.' });
    }
    try {
        const { certificateId, productId, manufacturerId, issueDate, expiryDate, certifyingBodyId } = req.body;

        if (!certificateId || !productId || !manufacturerId || !issueDate || !expiryDate || !certifyingBodyId) {
            return res.status(400).send({ success: false, message: 'Missing required certificate data fields' });
        }

        // 1. Prepare Off-Chain Data
        const offChainData = {
            // certificateId is the key, store other details
            productId: productId,
            manufacturerId: manufacturerId,
            issueDate: issueDate,
            expiryDate: expiryDate,
            certifyingBodyId: certifyingBodyId,
            // Add any other large/sensitive fields here if needed
            lastUpdated: new Date().toISOString() // Add a timestamp
        };

        console.log("Off-chain data prepared:", offChainData);
        
        // 2. Save/Update Off-Chain Data in MongoDB
        // Use upsert: update if exists (based on _id = certificateId), insert if not.
        const mongoResult = await certificatesCollection.updateOne(
            { _id: certificateId }, // Filter by certificateId (using it as MongoDB _id)
            { $set: offChainData }, // Data to set/update
            { upsert: true } // Option to insert if not found
        );
        console.log(`MongoDB update result for ID ${certificateId}:`, mongoResult);

        // 3. Calculate Hash of Off-Chain Data
        const offChainDataHash = calculateHash(offChainData);
        console.log(`Calculated SHA-256 Hash for off-chain data: ${offChainDataHash}`);

        // 4. Prepare On-Chain Data (only hash and status)
        const onChainIsValid = true; // Assume valid when adding/updating

        // 5. Send Transaction to Smart Contract
        const accounts = await web3.eth.getAccounts();
        if (accounts.length === 0) {
             return res.status(500).send({ success: false, message: 'No accounts found in Ganache.' });
        }
        const ownerAccount = accounts[0]; // Use the owner account (deployer)

        console.log(`Attempting smart contract update for ${certificateId} using account ${ownerAccount}`);

        const gasEstimateBigInt = await halalContract.methods.addOrUpdateCertificate(
            certificateId, offChainDataHash, onChainIsValid
        ).estimateGas({ from: ownerAccount });

        const gasEstimateNumber = Number(gasEstimateBigInt);
        const bufferedGasLimit = Math.floor(gasEstimateNumber * 1.2);

        const receipt = await halalContract.methods.addOrUpdateCertificate(
            certificateId, offChainDataHash, onChainIsValid
        ).send({ from: ownerAccount, gas: bufferedGasLimit });

        console.log('Blockchain transaction successful! Receipt:', receipt.transactionHash);
        res.status(200).send({ success: true, txHash: receipt.transactionHash });

    } catch (error) {
        console.error("!!! Error in /addCertificate endpoint:", error);
        res.status(500).send({ success: false, message: error.message });
    }
});

// MODIFIED Endpoint: Get Certificate Details (Hybrid)
app.get('/getCertificate/:certificateId', async (req, res) => {
     if (!certificatesCollection) {
         return res.status(503).send({ success: false, message: 'Database not connected yet.' });
    }
    try {
        const { certificateId } = req.params;
        console.log(`Workspaceing details for certificate ID: ${certificateId}`);

        // 1. Query Smart Contract for On-Chain Data (Hash and Status)
        console.log(`Querying smart contract for ID: ${certificateId}...`);
        const onChainData = await halalContract.methods.certificates(certificateId).call();
        console.log("On-chain data received:", onChainData);

        // Basic check if certificate exists on-chain
        if (!onChainData || onChainData.offchainDataHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
             return res.status(404).send({ success: false, message: 'Certificate not found on blockchain.' });
        }
         if (!onChainData.isValid) {
             return res.status(200).send({ success: true, message: 'Certificate found but is marked invalid.', data: { certificateId: certificateId, isValid: false } });
        }


        // 2. Query MongoDB for Off-Chain Data using certificateId
        console.log(`Querying MongoDB for ID: ${certificateId}...`);
        const offChainData = await certificatesCollection.findOne({ _id: certificateId });
         console.log("Off-chain data received:", offChainData);

        if (!offChainData) {
            // Data inconsistency! Hash exists on-chain, but data missing off-chain.
            console.error(`Inconsistency: Data for ID ${certificateId} not found in MongoDB, but hash exists on-chain.`);
             return res.status(500).send({ success: false, message: 'Data inconsistency error: Off-chain data not found.' });
        }

        const dataToHash = { ...offChainData };
        delete dataToHash._id;
        console.log("Data to hash:", dataToHash);

        // 3. (Optional but Recommended) Verify Hash Integrity
        const calculatedHash = calculateHash(dataToHash);
        if (calculatedHash !== onChainData.offchainDataHash) {
             console.error(`Data integrity check failed for ID ${certificateId}! On-chain hash: ${onChainData.offchainDataHash}, Calculated hash: ${calculatedHash}`);
             return res.status(500).send({ success: false, message: 'Data integrity check failed! Off-chain data may have been tampered with.' });
        }
         console.log(`Data integrity check passed for ID ${certificateId}.`);


        // 4. Combine On-Chain and Off-Chain Data
        const combinedData = {
            certificateId: certificateId, // Use the requested ID
            isValid: onChainData.isValid,
            offchainDataHash: onChainData.offchainDataHash, // Include hash for info
            ...offChainData // Spread the fields from the MongoDB document
        };

        res.status(200).send({ success: true, data: combinedData });

    } catch (error) {
        console.error("!!! Error in /getCertificate endpoint:", error);
        res.status(500).send({ success: false, message: error.message });
    }
});

// --- Start Server ---
async function startServer() {
    await connectDb(); // Connect to MongoDB first
    app.listen(port, () => {
        console.log(`======== Halal Chain Server Started (Hybrid Mode) ========`);
        console.log(`>> Listening at http://localhost:${port}`);
        console.log(`>> Connected to Ganache at ${ganacheUrl}`);
        console.log(`>> Using Contract Address: ${contractAddress}`);
        console.log(`>> Contract ABI loaded from: ./build/contracts/HalalCertificate.json`);
        console.log(`>> Connected to MongoDB: <span class="math-inline">\{dbName\}/</span>{collectionName}`);
        console.log(`=========================================================`);
    });
}

startServer(); // Call async function to start