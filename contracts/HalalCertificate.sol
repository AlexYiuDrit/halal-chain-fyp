// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19; // Use 0.8.19 for Ganache compatibility

// Import OpenZeppelin's Ownable contract for access control
import "@openzeppelin/contracts/access/Ownable.sol"; // Need to install this!

contract HalalCertificate is Ownable { // Inherit from Ownable

    struct Certificate {
        string certificateId;     // Keep as primary identifier
        bytes32 offchainDataHash; // Hash of the data stored off-chain (e.g., in MongoDB)
        bool isValid;             // Status flag remains on-chain
        // We don't store owner here, owner is contract-wide via Ownable
    }

    // Mapping: certificateId => Certificate data
    mapping(string => Certificate) public certificates;

    // --- Event ---
    // Emitted when a certificate is added or updated
    event CertificateUpdated(
        string indexed certificateId,
        bytes32 offchainDataHash,
        bool isValid,
        address indexed updatedBy // Address that triggered the update
    );

    // Constructor to set the initial owner (the deploying account)
    // Use constructor(address initialOwner) for Ownable v5+, or just constructor() for v4
    // Check your OpenZeppelin version. Assuming v4 for simplicity here.
    constructor() {
        // Owner is set automatically by Ownable constructor in v4
        // No need to pass msg.sender here
    }


    // MODIFIED Function: Now takes hash, includes validation, access control, and event
    function addOrUpdateCertificate(
        string memory _certificateId,
        bytes32 _offchainDataHash,
        bool _isValid
    ) public onlyOwner { // Apply the onlyOwner modifier

        // --- Input Validation ---
        require(bytes(_certificateId).length > 0, "Certificate ID cannot be empty");
        require(_offchainDataHash != bytes32(0), "Off-chain data hash cannot be zero");

        // Store the minimal on-chain data
        certificates[_certificateId] = Certificate(
            _certificateId,
            _offchainDataHash,
            _isValid
        );

        // --- Emit Event ---
        emit CertificateUpdated(
            _certificateId,
            _offchainDataHash,
            _isValid,
            msg.sender // Log the address that performed the action
        );
    }

    // We still rely on the public getter for 'certificates' to retrieve data.
    // Consider adding a dedicated getter function if more complex retrieval logic needed later.

    // Optional: Function to allow owner transfer (comes with Ownable)
    // function transferOwnership(address newOwner) public virtual override onlyOwner { ... }
}