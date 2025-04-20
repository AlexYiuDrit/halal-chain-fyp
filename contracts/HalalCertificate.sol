pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract HalalCertificate is AccessControl {

    // --- Role ---
    // Define bytes32 constants for role identifiers
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant CERTIFIER_ROLE = keccak256("CERTIFIER_ROLE");

    // --- Struct ---
    struct Certificate {
        string certificateId;
        bytes32 offchainDataHash;
        bool isValid;
    }

    // --- State Variables ---
    // Mapping: certificateId => Certificate data
    mapping(string => Certificate) public certificates;

    // --- Events ---
    event CertificateUpdated(
        string indexed certificateId,
        bytes32 offchainDataHash,
        bool isValid,
        address indexed updatedBy
    );

    event CertificateInvalidated(
        string indexed certificateId,
        address indexed invalidatedBy
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(CERTIFIER_ROLE, msg.sender);
        _setRoleAdmin(CERTIFIER_ROLE, ADMIN_ROLE);
    }


    // --- Certificate Management ---
    // Add/Update Certificate - restricted to CERTIFIER_ROLE
    function addOrUpdateCertificate(
        string memory _certificateId,
        bytes32 _offchainDataHash,
        bool _isValid
    ) public onlyRole(CERTIFIER_ROLE) {
        require(bytes(_certificateId).length > 0, "Certificate ID cannot be empty");
        require(_offchainDataHash != bytes32(0), "Off-chain data hash cannot be zero");

        certificates[_certificateId] = Certificate(
            _certificateId,
            _offchainDataHash,
            _isValid
        );

        emit CertificateUpdated(
            _certificateId,
            _offchainDataHash,
            _isValid,
            msg.sender
        );
    }

    // Invalidate Certificate - restricted to CERTIFIER_ROLE
    function invalidateCertificate(string memory _certificateId) public onlyRole(CERTIFIER_ROLE) {
        require(certificates[_certificateId].offchainDataHash != bytes32(0), "Certificate does not exist.");
        require(certificates[_certificateId].isValid == true, "Certificate is already invalid.");

        certificates[_certificateId].isValid = false;

        emit CertificateInvalidated(_certificateId, msg.sender);
    }

    // --- Role Management ---

    function grantCertifierRole(address account) public onlyRole(ADMIN_ROLE) {
        grantRole(CERTIFIER_ROLE, account);
    }

    function revokeCertifierRole(address account) public onlyRole(ADMIN_ROLE) {
        revokeRole(CERTIFIER_ROLE, account);
    }

    function renounceCertifierRole() public {
        renounceRole(CERTIFIER_ROLE, msg.sender);
    }
}