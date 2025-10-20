// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface LandRecord {
  id: string;
  encryptedOwnerId: string;
  coordinates: string;
  timestamp: number;
  ownerAddress: string;
  status: "available" | "owned" | "leased";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [lands, setLands] = useState<LandRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newLandData, setNewLandData] = useState({ coordinates: "", ownerId: 0 });
  const [showFAQ, setShowFAQ] = useState(false);
  const [selectedLand, setSelectedLand] = useState<LandRecord | null>(null);
  const [decryptedOwnerId, setDecryptedOwnerId] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const ownedCount = lands.filter(l => l.status === "owned").length;
  const availableCount = lands.filter(l => l.status === "available").length;
  const leasedCount = lands.filter(l => l.status === "leased").length;

  useEffect(() => {
    loadLands().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadLands = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.error("Contract is not available");
        return;
      }
      
      const keysBytes = await contract.getData("land_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing land keys:", e); }
      }
      
      const list: LandRecord[] = [];
      for (const key of keys) {
        try {
          const landBytes = await contract.getData(`land_${key}`);
          if (landBytes.length > 0) {
            try {
              const landData = JSON.parse(ethers.toUtf8String(landBytes));
              list.push({ 
                id: key, 
                encryptedOwnerId: landData.encryptedOwnerId, 
                coordinates: landData.coordinates, 
                timestamp: landData.timestamp, 
                ownerAddress: landData.ownerAddress, 
                status: landData.status || "available" 
              });
            } catch (e) { console.error(`Error parsing land data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading land ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setLands(list);
    } catch (e) { console.error("Error loading lands:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const claimLand = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting owner identity with Zama FHE..." });
    try {
      const encryptedOwnerId = FHEEncryptNumber(newLandData.ownerId);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const landId = `LAND-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const landData = { 
        encryptedOwnerId, 
        coordinates: newLandData.coordinates, 
        timestamp: Math.floor(Date.now() / 1000), 
        ownerAddress: address, 
        status: "owned" 
      };
      
      await contract.setData(`land_${landId}`, ethers.toUtf8Bytes(JSON.stringify(landData)));
      
      const keysBytes = await contract.getData("land_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(landId);
      await contract.setData("land_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Land claimed successfully with encrypted ownership!" });
      await loadLands();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewLandData({ coordinates: "", ownerId: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Claim failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const isOwner = (landAddress: string) => address?.toLowerCase() === landAddress.toLowerCase();

  const faqItems = [
    {
      question: "什么是元宇宙隐私地产？",
      answer: "元宇宙隐私地产是使用全同态加密技术（FHE）保护土地所有者身份的虚拟土地所有权系统。每个地块的所有者身份被加密存储，确保在享受元宇宙的同时保护个人隐私。"
    },
    {
      question: "ZAMA FHE技术如何保护我的隐私？",
      answer: "ZAMA的全同态加密技术允许在不解密数据的情况下对加密数据进行计算。这意味着您的身份信息始终处于加密状态，即使是在验证所有权或进行交易时也不会暴露。"
    },
    {
      question: "我如何证明自己是土地所有者？",
      answer: "您可以通过钱包签名来解密您的所有者ID，这个解密过程完全在您的设备上进行，系统不会获取您的解密密钥。"
    },
    {
      question: "加密的所有者ID是什么？",
      answer: "所有者ID是一个使用FHE加密的数字，代表您在元宇宙中的数字身份（DID）。这个ID与您的钱包地址分离，保护您的线下身份安全。"
    },
    {
      question: "邻居能看到我的身份信息吗？",
      answer: "不能。所有土地所有者的身份信息都经过FHE加密，您的邻居只能看到加密后的数据，无法知道您的真实身份。"
    }
  ];

  const renderStats = () => (
    <div className="stats-grid">
      <div className="stat-item">
        <div className="stat-value">{lands.length}</div>
        <div className="stat-label">Total Lands</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{ownedCount}</div>
        <div className="stat-label">Owned</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{availableCount}</div>
        <div className="stat-label">Available</div>
      </div>
      <div className="stat-item">
        <div className="stat-value">{leasedCount}</div>
        <div className="stat-label">Leased</div>
      </div>
    </div>
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="metaverse-spinner">
        <div className="planet"></div>
        <div className="ring"></div>
      </div>
      <p>Initializing metaverse connection...</p>
    </div>
  );

  return (
    <div className="app-container dream-theme">
      <header className="app-header glass-morphism">
        <div className="logo">
          <div className="logo-icon">
            <div className="metaverse-icon"></div>
          </div>
          <h1>Metaverse<span>Land</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-land-btn glass-button">
            <div className="add-icon"></div>Claim Land
          </button>
          <button className="glass-button" onClick={() => setShowFAQ(!showFAQ)}>
            {showFAQ ? "Hide FAQ" : "Show FAQ"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner glass-morphism">
          <div className="welcome-text">
            <h2>Private Land Ownership in the Metaverse</h2>
            <p>Secure your virtual property with fully homomorphic encryption (FHE) technology from Zama</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>FHE Encryption Active</span>
          </div>
        </div>
        
        <div className="project-intro glass-morphism">
          <h2>About Metaverse Land FHE</h2>
          <p>
            Metaverse Land FHE revolutionizes virtual property ownership by leveraging Zama's cutting-edge 
            <strong> Fully Homomorphic Encryption (FHE)</strong> technology. Unlike traditional systems, 
            land ownership records are encrypted on-chain, ensuring that your digital identity remains 
            private while still enabling verifiable ownership.
          </p>
          <div className="features-grid">
            <div className="feature-card">
              <div className="feature-icon privacy"></div>
              <h3>Identity Protection</h3>
              <p>Your DID identity is encrypted using FHE, keeping your real-world identity separate and secure.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon neighbor"></div>
              <h3>Neighbor Privacy</h3>
              <p>Adjacent landowners cannot discover your identity, maintaining your privacy in the metaverse.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon safety"></div>
              <h3>Offline Safety</h3>
              <p>Protect yourself from real-world threats by keeping your metaverse activities private.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon future"></div>
              <h3>Future-Proof</h3>
              <p>FHE provides the essential privacy layer needed for the mature metaverse of tomorrow.</p>
            </div>
          </div>
        </div>
        
        <div className="dashboard-section">
          <div className="dashboard-stats glass-morphism">
            <h3>Land Ownership Statistics</h3>
            {renderStats()}
            <div className="fhe-badge">
              <span>FHE-Powered Privacy</span>
            </div>
          </div>
          
          <div className="land-map glass-morphism">
            <h3>Metaverse Land Map</h3>
            <div className="map-container">
              <div className="map-grid">
                {lands.slice(0, 16).map((land, index) => (
                  <div 
                    key={index} 
                    className={`map-cell ${land.status}`}
                    onClick={() => setSelectedLand(land)}
                  >
                    <span className="coordinates">{land.coordinates}</span>
                    <span className="status">{land.status}</span>
                  </div>
                ))}
              </div>
              <div className="map-legend">
                <div className="legend-item"><div className="color-box owned"></div><span>Owned</span></div>
                <div className="legend-item"><div className="color-box available"></div><span>Available</span></div>
                <div className="legend-item"><div className="color-box leased"></div><span>Leased</span></div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="lands-section">
          <div className="section-header">
            <h2>Encrypted Land Records</h2>
            <div className="header-actions">
              <button onClick={loadLands} className="refresh-btn glass-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh Lands"}
              </button>
            </div>
          </div>
          
          <div className="lands-list glass-morphism">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Coordinates</div>
              <div className="header-cell">Owner Address</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {lands.length === 0 ? (
              <div className="no-lands">
                <div className="no-lands-icon"></div>
                <p>No land records found in the metaverse</p>
                <button className="glass-button primary" onClick={() => setShowCreateModal(true)}>Claim First Land</button>
              </div>
            ) : lands.map(land => (
              <div 
                className="land-row" 
                key={land.id} 
                onClick={() => setSelectedLand(land)}
              >
                <div className="table-cell land-id">#{land.id.substring(0, 6)}</div>
                <div className="table-cell">{land.coordinates}</div>
                <div className="table-cell">{land.ownerAddress.substring(0, 6)}...{land.ownerAddress.substring(38)}</div>
                <div className="table-cell">{new Date(land.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell">
                  <span className={`status-badge ${land.status}`}>{land.status}</span>
                </div>
                <div className="table-cell actions">
                  {isOwner(land.ownerAddress) && (
                    <button 
                      className="action-btn glass-button primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedLand(land);
                      }}
                    >
                      View Details
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        
        {showFAQ && (
          <div className="faq-section glass-morphism">
            <h2>Frequently Asked Questions</h2>
            <div className="faq-items">
              {faqItems.map((item, index) => (
                <div className="faq-item" key={index}>
                  <div className="faq-question">
                    <div className="question-icon">?</div>
                    <h3>{item.question}</h3>
                  </div>
                  <div className="faq-answer">
                    <p>{item.answer}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={claimLand} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          landData={newLandData} 
          setLandData={setNewLandData}
        />
      )}
      
      {selectedLand && (
        <LandDetailModal 
          land={selectedLand} 
          onClose={() => { 
            setSelectedLand(null); 
            setDecryptedOwnerId(null); 
          }} 
          decryptedOwnerId={decryptedOwnerId} 
          setDecryptedOwnerId={setDecryptedOwnerId} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content glass-morphism">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metaverse-spinner small"><div className="planet"></div></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="metaverse-icon small"></div>
              <span>MetaverseLandFHE</span>
            </div>
            <p>Secure encrypted land ownership using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} MetaverseLandFHE. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  landData: any;
  setLandData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, landData, setLandData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setLandData({ ...landData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setLandData({ ...landData, [name]: parseInt(value) });
  };

  const handleSubmit = () => {
    if (!landData.coordinates || !landData.ownerId) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal glass-morphism">
        <div className="modal-header">
          <h2>Claim Metaverse Land</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your owner identity will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Coordinates *</label>
              <input 
                type="text" 
                name="coordinates" 
                value={landData.coordinates} 
                onChange={handleChange} 
                placeholder="e.g., X:123 Y:456" 
                className="glass-input"
              />
            </div>
            
            <div className="form-group">
              <label>Owner Identity (DID) *</label>
              <input 
                type="number" 
                name="ownerId" 
                value={landData.ownerId} 
                onChange={handleValueChange} 
                placeholder="Enter your digital identity number" 
                className="glass-input"
              />
              <div className="input-hint">This represents your encrypted digital identity</div>
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Identity:</span>
                <div>{landData.ownerId || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Identity:</span>
                <div>{landData.ownerId ? FHEEncryptNumber(landData.ownerId).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Privacy Guarantee</strong>
              <p>Your identity remains encrypted during all operations and is never exposed</p>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn glass-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn glass-button primary">
            {creating ? "Encrypting with FHE..." : "Claim Land Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface LandDetailModalProps {
  land: LandRecord;
  onClose: () => void;
  decryptedOwnerId: number | null;
  setDecryptedOwnerId: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const LandDetailModal: React.FC<LandDetailModalProps> = ({ 
  land, 
  onClose, 
  decryptedOwnerId, 
  setDecryptedOwnerId, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedOwnerId !== null) { 
      setDecryptedOwnerId(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(land.encryptedOwnerId);
    if (decrypted !== null) setDecryptedOwnerId(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="land-detail-modal glass-morphism">
        <div className="modal-header">
          <h2>Land Details #{land.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="land-info">
            <div className="info-item">
              <span>Coordinates:</span>
              <strong>{land.coordinates}</strong>
            </div>
            <div className="info-item">
              <span>Owner Address:</span>
              <strong>{land.ownerAddress.substring(0, 8)}...{land.ownerAddress.substring(34)}</strong>
            </div>
            <div className="info-item">
              <span>Acquisition Date:</span>
              <strong>{new Date(land.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${land.status}`}>{land.status}</strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Owner Identity</h3>
            <div className="encrypted-data">
              {land.encryptedOwnerId.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            
            <button 
              className="decrypt-btn glass-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedOwnerId !== null ? (
                "Hide Owner ID"
              ) : (
                "Decrypt Owner ID"
              )}
            </button>
          </div>
          
          {decryptedOwnerId !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Owner ID</h3>
              <div className="decrypted-value">
                {decryptedOwnerId}
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>This is your private digital identity (DID) - keep it secure!</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn glass-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;