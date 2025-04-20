const express = require('express');
const Web3 = require('web3').default;
const path = require('path');
const { MongoClient, ServerApiVersion } = require('mongodb');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = 3000;

// Variable to simulate user role for Role-Based Access Control (RBAC) testing
// 0 for Certifier (accounts[0]), 1 for Non-Certifier (accounts[1])
let simulatedUserAccountIndex = 0;

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
        await mongoClient.connect();
        db = mongoClient.db(dbName);
        certificatesCollection = db.collection(collectionName);
        console.log(`Successfully connected to MongoDB Atlas! Database: ${dbName}, Collection: ${collectionName}`);
    } catch (err) {
        console.error('!!! Failed to connect to MongoDB Atlas:', err);
        await mongoClient.close();
        process.exit(1);
    }
}

// --- Web3 Contract Instance Setup ---
let halalContract;
let contractAddress;

try {
    // Load contract ABI and address from build artifacts
    const contractJson = require('./build/contracts/HalalCertificate.json');
    const contractABI = contractJson.abi;

    // Dynamically find the address from the most recent deployment
    const networkId = Object.keys(contractJson.networks)[Object.keys(contractJson.networks).length - 1];
    const deployedNetwork = contractJson.networks[networkId];

    if (!deployedNetwork || !deployedNetwork.address) {
        throw new Error("Contract address not found in build artifact. Ensure contract is deployed.");
    }
    contractAddress = deployedNetwork.address;

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

// Calculates SHA-256 hash of provided data object after sorting keys for consistency.
function calculateHash(data) {
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
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Handles adding a new certificate or updating an existing one.
// It calculates the hash of off-chain data, sends a transaction to the smart contract
// with the hash and validity status, and stores the full data in MongoDB.
app.post('/addCertificate', async (req, res) => {
    if (!certificatesCollection) {
        return res.status(503).send({ success: false, message: 'Database not connected yet.' });
    }
    try {
        const {
            certificateId, productId, manufacturerId, issueDate, expiryDate, certifyingBodyId,
        } = req.body;

        if (!certificateId || !productId || !manufacturerId || !issueDate || !expiryDate || !certifyingBodyId) {
            return res.status(400).send({ success: false, message: 'Missing required certificate data fields' });
        }

        const offChainData = {
            productId: productId,
            manufacturerId: manufacturerId,
            issueDate: issueDate,
            expiryDate: expiryDate,
            certifyingBodyId: certifyingBodyId,
            lastUpdated: new Date().toISOString()
        };

        const offChainDataHash = calculateHash(offChainData);
        console.log(`Calculated SHA-256 Hash for off-chain data: ${offChainDataHash}`);

        const onChainIsValid = true;
        const accounts = await web3.eth.getAccounts();
        if (accounts.length < 2) {
            return res.status(500).send({ success: false, message: 'Need at least 2 accounts in Ganache for RBAC demo.' });
        }
        const transactionAccount = accounts[simulatedUserAccountIndex];
        console.log(`Simulating action as ${simulatedUserAccountIndex === 0 ? 'CERTIFIER (Account 0)' : 'NON-CERTIFIER (Account 1)'}: ${transactionAccount}`);

        console.log(`Attempting smart contract update for ${certificateId} using account ${transactionAccount}`);
        const gasEstimateBigInt = await halalContract.methods.addOrUpdateCertificate(
            certificateId, offChainDataHash, onChainIsValid
        ).estimateGas({ from: transactionAccount });
        const gasEstimateNumber = Number(gasEstimateBigInt);
        const bufferedGasLimit = Math.floor(gasEstimateNumber * 1.2);

        const receipt = await halalContract.methods.addOrUpdateCertificate(
            certificateId, offChainDataHash, onChainIsValid
        ).send({ from: transactionAccount, gas: bufferedGasLimit });
        console.log('Blockchain transaction successful! Receipt:', receipt.transactionHash);

        const mongoResult = await certificatesCollection.updateOne(
            { _id: certificateId },
            { $set: { ...offChainData, isValid: true } },
            { upsert: true }
        );
        console.log(`MongoDB update result for ID ${certificateId}:`, mongoResult);

        res.status(200).send({ success: true, txHash: receipt.transactionHash });

    } catch (error) {
        console.error("!!! Error in /addCertificate endpoint:", error);

        let errorMessage = "An unexpected error occurred while adding/updating certificate.";
        let statusCode = 500;
        let revertReason = null;

        if (error.reason) {
            revertReason = error.reason;
        } else if (error.cause && typeof error.cause.message === 'string') {
            const causeMessage = error.cause.message;
            const match = causeMessage.match(/revert\s*(.*)/);
            revertReason = (match && match[1]) ? match[1].trim() : causeMessage;
        } else if (typeof error.message === 'string') {
            const message = error.message;
            const match = message.match(/revert\s*(.*)/);
            if (match && match[1]) {
                revertReason = match[1].trim().split('\n')[0];
            }
        }

        if (revertReason) {
            console.log("Detected Revert Reason:", revertReason);
            if (revertReason.includes("AccessControl: account") && revertReason.includes("is missing role")) {
                 errorMessage = "Permission Denied: Action requires CERTIFIER role.";
                 statusCode = 403;
            } else {
                errorMessage = `Smart contract execution reverted: ${revertReason}`;
                statusCode = 400;
            }
        } else if (error && error.code === 310) {
             errorMessage = "Smart contract execution failed without a specific reason.";
             statusCode = 500;
        }

        res.status(statusCode).send({ success: false, message: errorMessage });
    }
});

// Retrieves certificate details by ID.
// It fetches the hash and status from the smart contract, retrieves the full data
// from MongoDB, verifies the hash, and returns the combined data.
app.get('/getCertificate/:certificateId', async (req, res) => {
    if (!certificatesCollection) {
        return res.status(503).send({ success: false, message: 'Database not connected yet.' });
    }
    try {
        const { certificateId } = req.params;

        const onChainData = await halalContract.methods.certificates(certificateId).call();

        if (!onChainData || onChainData.offchainDataHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            return res.status(404).send({ success: false, message: 'Certificate not found on blockchain.' });
        }

        if (!onChainData.isValid) {
            return res.status(200).send({ success: true, message: 'Certificate found but is marked invalid.', data: { certificateId: certificateId, isValid: false } });
        }

        const offChainData = await certificatesCollection.findOne({ _id: certificateId });

        if (!offChainData) {
            console.error(`Inconsistency: Data for ID ${certificateId} not found in MongoDB, but hash exists on-chain.`);
            return res.status(500).send({ success: false, message: 'Data inconsistency error: Off-chain data not found.' });
        }

        const dataToHash = { ...offChainData };
        delete dataToHash._id;
        delete dataToHash.isValid;

        const calculatedHash = calculateHash(dataToHash);
        if (calculatedHash !== onChainData.offchainDataHash) {
            console.error(`Data integrity check failed for ID ${certificateId}! On-chain hash: ${onChainData.offchainDataHash}, Calculated hash: ${calculatedHash}`);
            return res.status(500).send({ success: false, message: 'Data integrity check failed! Off-chain data may have been tampered with.' });
        }
        console.log(`Data integrity check passed for ID ${certificateId}.`);

        const combinedData = {
            certificateId: certificateId,
            isValid: onChainData.isValid,
            offchainDataHash: onChainData.offchainDataHash,
            ...offChainData
        };
        res.status(200).send({ success: true, data: combinedData });

    } catch (error) {
        console.error("!!! Error in /getCertificate endpoint:", error);
        res.status(500).send({ success: false, message: "An unexpected error occurred while retrieving the certificate." });
    }
});

// Marks a certificate as invalid on the blockchain and updates the status in MongoDB.
app.post('/invalidateCertificate/:certificateId', async (req, res) => {
    if (!certificatesCollection || !halalContract) {
        return res.status(503).send({ success: false, message: 'Server components not ready.' });
    }
    try {
        const { certificateId } = req.params;
        console.log(`Attempting to invalidate certificate ID: ${certificateId}`);

        if (!certificateId) {
            return res.status(400).send({ success: false, message: 'Certificate ID is required.' });
        }

        const accounts = await web3.eth.getAccounts();
        if (accounts.length < 2) {
            return res.status(500).send({ success: false, message: 'Need at least 2 accounts in Ganache for RBAC demo.' });
        }
        const transactionAccount = accounts[simulatedUserAccountIndex];
        console.log(`Simulating action as ${simulatedUserAccountIndex === 0 ? 'CERTIFIER (Account 0)' : 'NON-CERTIFIER (Account 1)'}: ${transactionAccount}`);

        const gasEstimateBigInt = await halalContract.methods.invalidateCertificate(
            certificateId
        ).estimateGas({ from: transactionAccount });
        const gasEstimateNumber = Number(gasEstimateBigInt);
        const bufferedGasLimit = Math.floor(gasEstimateNumber * 1.2);

        const receipt = await halalContract.methods.invalidateCertificate(
            certificateId
        ).send({ from: transactionAccount, gas: bufferedGasLimit });
        console.log('Invalidation transaction successful! Receipt:', receipt.transactionHash);

        await certificatesCollection.updateOne(
            { _id: certificateId },
            { $set: { isValid: false, lastUpdated: new Date().toISOString() } }
        );
        console.log(`MongoDB record for ${certificateId} marked as invalid.`);

        res.status(200).send({ success: true, message: `Certificate ${certificateId} marked as invalid.`, txHash: receipt.transactionHash });

    } catch (error) {
        console.error("!!! Error in /invalidateCertificate endpoint:", error);

        let errorMessage = "An unexpected error occurred during invalidation.";
        let statusCode = 500;
        let revertReason = null;

        if (error.reason) {
            revertReason = error.reason;
        } else if (error.cause && typeof error.cause.message === 'string') {
            const causeMessage = error.cause.message;
            const match = causeMessage.match(/revert\s*(.*)/);
            revertReason = (match && match[1]) ? match[1].trim() : causeMessage;
        } else if (typeof error.message === 'string') {
            const message = error.message;
            const match = message.match(/revert\s*(.*)/);
            if (match && match[1]) {
                revertReason = match[1].trim().split('\n')[0];
            }
        }

        if (revertReason) {
             console.log("Detected Revert Reason:", revertReason);
             if (revertReason.includes("Certificate does not exist.")) {
                 errorMessage = "Certificate ID not found on the blockchain.";
                 statusCode = 404;
             } else if (revertReason.includes("Certificate is already invalid.")) {
                 errorMessage = "Certificate is already marked as invalid.";
                 statusCode = 400;
             } else if (revertReason.includes("AccessControl: account") && revertReason.includes("is missing role")) {
                 errorMessage = "Permission Denied: Action requires CERTIFIER role.";
                 statusCode = 403;
             } else {
                 errorMessage = `Smart contract execution reverted: ${revertReason}`;
                 statusCode = 400;
             }
         } else if (error && error.code === 310) {
              errorMessage = "Smart contract execution failed without a specific reason.";
              statusCode = 500;
         }

        res.status(statusCode).send({ success: false, message: errorMessage });
    }
});

// Switches the simulated user role between Certifier (Account 0) and Non-Certifier (Account 1).
app.post('/simulateRole', (req, res) => {
    const { role } = req.body;
    if (role === 'CERTIFIER') {
        simulatedUserAccountIndex = 0;
        console.log("Switched simulated role to CERTIFIER (Account 0)");
        res.status(200).send({ success: true, message: 'Simulating as Certifier (Account 0)' });
    } else if (role === 'NON_CERTIFIER') {
        simulatedUserAccountIndex = 1;
        console.log("Switched simulated role to NON_CERTIFIER (Account 1)");
        res.status(200).send({ success: true, message: 'Simulating as Non-Certifier (Account 1)' });
    } else {
        res.status(400).send({ success: false, message: 'Invalid role specified' });
    }
});

// Returns the currently simulated role.
app.get('/getCurrentRole', (req, res) => {
    const currentRole = simulatedUserAccountIndex === 0 ? 'CERTIFIER (Account 0)' : 'NON_CERTIFIER (Account 1)';
    res.status(200).send({ success: true, role: currentRole });
});

// --- Start Server ---
// Initializes DB connection and starts the Express server.
async function startServer() {
    await connectDb();
    app.listen(port, () => {
        console.log(`======== Halal Chain Server Started (Hybrid Mode) ========`);
        console.log(`>> Listening at http://localhost:${port}`);
        console.log(`>> Connected to Ganache at ${ganacheUrl}`);
        console.log(`>> Using Contract Address: ${contractAddress}`);
        console.log(`>> Contract ABI loaded from: ./build/contracts/HalalCertificate.json`);
        console.log(`>> Connected to MongoDB: ${dbName}/${collectionName}`);
        console.log(`=========================================================`);
    });
}

startServer();
