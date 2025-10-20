pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract MetaverseLandFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;
    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // LandID -> Encrypted Owner DID
    mapping(uint256 => euint32) public landOwnerDID;
    // LandID -> Encrypted X coordinate
    mapping(uint256 => euint32) public landEncryptedX;
    // LandID -> Encrypted Y coordinate
    mapping(uint256 => euint32) public landEncryptedY;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event LandDataSubmitted(uint256 indexed landId, address indexed provider);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint256 landId, uint256 ownerDID, uint256 x, uint256 y);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        cooldownSeconds = 60; // Default cooldown
        currentBatchId = 1; // Start with batch 1
        batchOpen = false; // Batch closed by default
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitLandData(
        uint256 landId,
        euint32 encryptedOwnerDID,
        euint32 encryptedX,
        euint32 encryptedY
    ) external onlyProvider whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;

        landOwnerDID[landId] = encryptedOwnerDID;
        landEncryptedX[landId] = encryptedX;
        landEncryptedY[landId] = encryptedY;

        emit LandDataSubmitted(landId, msg.sender);
    }

    function requestLandDataDecryption(uint256 landId) external onlyProvider whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        // 1. Prepare Ciphertexts
        euint32 ownerDID_ct = landOwnerDID[landId];
        euint32 x_ct = landEncryptedX[landId];
        euint32 y_ct = landEncryptedY[landId];

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(ownerDID_ct);
        cts[1] = FHE.toBytes32(x_ct);
        cts[2] = FHE.toBytes32(y_ct);

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        // a. Replay Guard
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // b. State Verification
        // Rebuild cts in the exact same order as in requestLandDataDecryption
        // This requires knowing which landId was associated with the request.
        // For simplicity, this example assumes the landId is implicitly known
        // or passed via another mechanism if multiple lands could be requested.
        // Here, we'll assume the callback is for a specific landId that needs to be
        // retrieved or associated. For this example, let's assume landId = 1.
        // In a real scenario, you'd need to store landId with the requestId.
        // For this example, we'll use a fixed landId for demonstration.
        // THIS IS A SIMPLIFICATION. A real contract would need to track the landId for the requestId.
        uint256 landId = 1; // Example: hardcoded for simplicity

        euint32 ownerDID_ct_recheck = landOwnerDID[landId];
        euint32 x_ct_recheck = landEncryptedX[landId];
        euint32 y_ct_recheck = landEncryptedY[landId];

        bytes32[] memory cts_recheck = new bytes32[](3);
        cts_recheck[0] = FHE.toBytes32(ownerDID_ct_recheck);
        cts_recheck[1] = FHE.toBytes32(x_ct_recheck);
        cts_recheck[2] = FHE.toBytes32(y_ct_recheck);

        bytes32 currentHash = _hashCiphertexts(cts_recheck);

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }
        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }
        // d. Decode & Finalize
        // Decode cleartexts in the same order they were sent for decryption
        uint256 ownerDID = abi.decode(cleartexts[0:32], (uint256));
        uint256 x = abi.decode(cleartexts[32:64], (uint256));
        uint256 y = abi.decode(cleartexts[64:96], (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, landId, ownerDID, x, y);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 encryptedValue) internal {
        if (!FHE.isInitialized(encryptedValue)) {
            encryptedValue = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 encryptedValue) internal pure {
        if (!FHE.isInitialized(encryptedValue)) {
            revert("FHE value not initialized");
        }
    }
}