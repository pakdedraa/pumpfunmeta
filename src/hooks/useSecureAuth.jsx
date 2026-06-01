/**
 * useSecureAuth.jsx — Secure Authentication Hook
 *
 * Menggantikan useAuth.jsx yang lama dengan sistem yang aman:
 * - Real wallet integration
 * - Encrypted storage
 * - Session management
 * - Auto-logout
 */

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { WalletStorage } from '../utils/walletManager';
import { SecureStorage } from '../utils/encryption';

const AuthContext = createContext(null);

const SOLANA_RPC = import.meta.env.VITE_SOLANA_RPC || 'https://rpc.ankr.com/solana';
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 menit
const BALANCE_REFRESH_INTERVAL = 30 * 1000; // 30 detik

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState(null);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [sessionPassword, setSessionPassword] = useState(null);

  // Initialize Solana connection
  useEffect(() => {
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    setConnection(conn);
  }, []);

  // Auto-logout setelah idle
  useEffect(() => {
    if (!user) return;

    const checkActivity = setInterval(() => {
      if (Date.now() - lastActivity > SESSION_TIMEOUT) {
        logout();
      }
    }, 60000); // Check setiap 1 menit

    return () => clearInterval(checkActivity);
  }, [user, lastActivity]);

  // Track user activity
  useEffect(() => {
    if (!user) return;

    const updateActivity = () => setLastActivity(Date.now());

    window.addEventListener('mousemove', updateActivity);
    window.addEventListener('keydown', updateActivity);
    window.addEventListener('click', updateActivity);

    return () => {
      window.removeEventListener('mousemove', updateActivity);
      window.removeEventListener('keydown', updateActivity);
      window.removeEventListener('click', updateActivity);
    };
  }, [user]);

  // Refresh balance periodically
  useEffect(() => {
    if (!user || !connection) return;

    const refreshBalance = async () => {
      try {
        const publicKey = new PublicKey(user.publicKey);
        const balance = await connection.getBalance(publicKey);
        const balanceSol = balance / LAMPORTS_PER_SOL;

        setUser(prev => ({
          ...prev,
          balanceSol,
          lastBalanceUpdate: Date.now()
        }));
      } catch (error) {
        console.error('Failed to refresh balance:', error);
      }
    };

    // Initial refresh
    refreshBalance();

    // Periodic refresh
    const interval = setInterval(refreshBalance, BALANCE_REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [user?.publicKey, connection]);

  // Check for existing session on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const sessionData = sessionStorage.getItem('memeagent_session');
        if (sessionData) {
          const session = JSON.parse(sessionData);

          // Verify session not expired
          if (Date.now() - session.timestamp < SESSION_TIMEOUT) {
            setUser(session.user);
            setSessionPassword(session.password);
            setLastActivity(session.timestamp);
          } else {
            sessionStorage.removeItem('memeagent_session');
          }
        }
      } catch (error) {
        console.error('Session check failed:', error);
      } finally {
        setLoading(false);
      }
    };

    checkSession();
  }, []);

  // Save session to sessionStorage
  const saveSession = useCallback((userData, password) => {
    const session = {
      user: userData,
      password,
      timestamp: Date.now()
    };
    sessionStorage.setItem('memeagent_session', JSON.stringify(session));
  }, []);

  /**
   * Connect wallet (browser wallet atau imported)
   */
  const connectWallet = useCallback(async (walletData) => {
    try {
      setLoading(true);

      let balanceSol = 0;
      if (connection && walletData.publicKey) {
        try {
          const publicKey = new PublicKey(walletData.publicKey);
          const balance = await connection.getBalance(publicKey);
          balanceSol = balance / LAMPORTS_PER_SOL;
        } catch (error) {
          console.error('Failed to fetch balance:', error);
        }
      }

      const userData = {
        id: 'user_' + Math.random().toString(36).slice(2, 10),
        publicKey: walletData.publicKey,
        walletType: walletData.type,
        provider: walletData.provider,
        canSign: walletData.canSign,
        encrypted: walletData.encrypted || false,
        balanceSol,
        connectedAt: Date.now(),
        lastBalanceUpdate: Date.now()
      };

      setUser(userData);
      setLastActivity(Date.now());

      // Save session (password hanya untuk encrypted wallet)
      if (walletData.password) {
        setSessionPassword(walletData.password);
        saveSession(userData, walletData.password);
      } else {
        saveSession(userData, null);
      }

      return true;
    } catch (error) {
      console.error('Connect wallet failed:', error);
      return false;
    } finally {
      setLoading(false);
    }
  }, [connection, saveSession]);

  /**
   * Disconnect wallet dan clear session
   */
  const logout = useCallback(() => {
    // Disconnect browser wallet if connected
    if (user?.walletType === 'browser' && window.solana?.disconnect) {
      window.solana.disconnect().catch(console.error);
    }

    setUser(null);
    setSessionPassword(null);
    sessionStorage.removeItem('memeagent_session');
  }, [user]);

  /**
   * Get private key untuk signing (hanya untuk encrypted wallet)
   */
  const getPrivateKey = useCallback(async (password = null) => {
    if (!user?.encrypted) {
      throw new Error('Wallet ini tidak mendukung private key export');
    }

    const pwd = password || sessionPassword;
    if (!pwd) {
      throw new Error('Password diperlukan untuk unlock wallet');
    }

    try {
      const wallet = await WalletStorage.load(pwd);
      return wallet.privateKey;
    } catch (error) {
      throw new Error('Password salah atau wallet corrupt');
    }
  }, [user, sessionPassword]);

  /**
   * Sign transaction
   */
  const signTransaction = useCallback(async (transaction, password = null) => {
    if (!user) {
      throw new Error('Wallet tidak terhubung');
    }

    // Browser wallet
    if (user.walletType === 'browser') {
      if (!window.solana?.signTransaction) {
        throw new Error('Browser wallet tidak mendukung signing');
      }
      return await window.solana.signTransaction(transaction);
    }

    // Encrypted wallet
    if (user.encrypted) {
      const { signTransaction: sign } = await import('../utils/walletManager');
      const privateKey = await getPrivateKey(password);
      return sign(transaction, privateKey);
    }

    throw new Error('Wallet tidak mendukung signing');
  }, [user, getPrivateKey]);

  /**
   * Send transaction
   */
  const sendTransaction = useCallback(async (transaction, password = null) => {
    if (!connection) {
      throw new Error('Solana connection tidak tersedia');
    }

    const signedTx = await signTransaction(transaction, password);
    const signature = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction(signature, 'confirmed');

    return signature;
  }, [connection, signTransaction]);

  /**
   * Refresh balance manually
   */
  const refreshBalance = useCallback(async () => {
    if (!user || !connection) return;

    try {
      const publicKey = new PublicKey(user.publicKey);
      const balance = await connection.getBalance(publicKey);
      const balanceSol = balance / LAMPORTS_PER_SOL;

      setUser(prev => ({
        ...prev,
        balanceSol,
        lastBalanceUpdate: Date.now()
      }));

      return balanceSol;
    } catch (error) {
      console.error('Failed to refresh balance:', error);
      throw error;
    }
  }, [user, connection]);

  /**
   * Change wallet password (hanya untuk encrypted wallet)
   */
  const changePassword = useCallback(async (oldPassword, newPassword) => {
    if (!user?.encrypted) {
      throw new Error('Wallet ini tidak mendukung password change');
    }

    try {
      await WalletStorage.changePassword(oldPassword, newPassword);
      setSessionPassword(newPassword);

      // Update session
      if (user) {
        saveSession(user, newPassword);
      }

      return true;
    } catch (error) {
      throw new Error('Gagal mengubah password: ' + error.message);
    }
  }, [user, saveSession]);

  /**
   * Export keystore file
   */
  const exportKeystore = useCallback(async (password = null) => {
    if (!user?.encrypted) {
      throw new Error('Wallet ini tidak mendukung keystore export');
    }

    const pwd = password || sessionPassword;
    if (!pwd) {
      throw new Error('Password diperlukan untuk export keystore');
    }

    try {
      const { createKeystore, downloadKeystore } = await import('../utils/walletManager');
      const privateKey = await getPrivateKey(pwd);
      const keystore = await createKeystore(privateKey, pwd);
      downloadKeystore(keystore);
      return true;
    } catch (error) {
      throw new Error('Gagal export keystore: ' + error.message);
    }
  }, [user, sessionPassword, getPrivateKey]);

  /**
   * Get session time remaining
   */
  const getSessionTimeRemaining = useCallback(() => {
    if (!user) return 0;
    const remaining = SESSION_TIMEOUT - (Date.now() - lastActivity);
    return Math.max(0, remaining);
  }, [user, lastActivity]);

  const value = {
    user,
    loading,
    connection,
    connectWallet,
    logout,
    signTransaction,
    sendTransaction,
    refreshBalance,
    changePassword,
    exportKeystore,
    getSessionTimeRemaining,
    isAuthenticated: !!user,
    canSign: user?.canSign || false,
    isEncrypted: user?.encrypted || false
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
