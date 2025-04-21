const express = require('express');
const cors = require('cors');
const { 
  Client, 
  PrivateKey, 
  AccountId,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  TokenMintTransaction,
  TokenBurnTransaction,
  TokenInfoQuery,
  TransferTransaction,
  TokenAssociateTransaction,
  AccountBalanceQuery
} = require('@hashgraph/sdk');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(express.json());
app.use(cors());

// Track token ownership, metadata, and balances
const tokenOwnership = {}; // Primary owner of the token
const tokenMetadata = {};  // Metadata about the token
const tokenBalances = {};  // Track balances by tokenId and accountId

// Helper function to get current timestamp
function getCurrentTimestamp() {
  return new Date().toISOString();
}

// Initialize Hedera client
function getClient() {
  // Get operator from .env file
  const myAccountId = AccountId.fromString(process.env.MY_ACCOUNT_ID);
  const myPrivateKey = PrivateKey.fromString(process.env.MY_PRIVATE_KEY);

  // Create connection to the Hedera network
  const client = Client.forTestnet(); // Use forMainnet() for production
  client.setOperator(myAccountId, myPrivateKey);
  
  return {
    client,
    operatorPrivateKey: myPrivateKey,
    operatorPublicKey: myPrivateKey.publicKey, // Derive public key from private key
    operatorAccountId: myAccountId
  };
}

// Helper function to update token balances
async function updateTokenBalances(tokenId) {
  try {
    const { client } = getClient();
    
    // Initialize balance tracking for this token if it doesn't exist
    if (!tokenBalances[tokenId]) {
      tokenBalances[tokenId] = {};
    }
    
    // For each known account that has this token, get their balance
    for (const accountId of Object.keys(tokenBalances[tokenId])) {
      try {
        const balance = await new AccountBalanceQuery()
          .setAccountId(accountId)
          .execute(client);
          
        const tokenBalance = balance.tokens._map.get(tokenId);
        if (tokenBalance) {
          const tokenInfo = await new TokenInfoQuery()
            .setTokenId(tokenId)
            .execute(client);
            
          const decimals = tokenInfo.decimals;
          const balanceInKg = tokenBalance.toNumber() / (10 ** decimals);
          
          // Update balance
          tokenBalances[tokenId][accountId] = balanceInKg;
        }
      } catch (error) {
        console.warn(`Could not get balance for account ${accountId}, token ${tokenId}: ${error.message}`);
      }
    }
    
    return tokenBalances[tokenId];
  } catch (error) {
    console.error(`Failed to update token balances for ${tokenId}: ${error.message}`);
    return null;
  }
}

// POST endpoint to create a product token
app.post('/api/tokens/create', async (req, res) => {
  try {
    const { 
      productName, 
      initialStockKg,
      creatorAccountId, // Account ID of the product creator
      creatorPrivateKey, // Private key of the creator (for signing)
      metadata = {} // Optional product metadata
    } = req.body;
    
    // Validate required parameters
    if (!productName || initialStockKg === undefined) {
      return res.status(400).json({ error: 'Missing required parameters: productName, initialStockKg' });
    }

    const { client, operatorPrivateKey, operatorPublicKey, operatorAccountId } = getClient();
    
    // Use the provided creatorAccountId or fall back to the operator account
    const ownerAccountId = creatorAccountId ? AccountId.fromString(creatorAccountId) : operatorAccountId;
    
    // Parse creator's private key if provided
    let ownerPrivateKey = null;
    if (creatorPrivateKey) {
      try {
        ownerPrivateKey = PrivateKey.fromString(creatorPrivateKey);
      } catch (err) {
        return res.status(400).json({ 
          error: 'Invalid creator private key format',
          details: err.message
        });
      }
    }

    // Generate a timestamp for uniqueness
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    
    // Create a token name with product info
    const tokenName = `${productName} Stock Token`;
    
    // Generate a symbol based on the product name and timestamp
    // This ensures uniqueness without requiring a product ID
    const symbol = `${productName.substring(0, 4).toUpperCase()}-${timestamp.slice(-4)}`;
    
    // Create the token with initial stock in kg
    // We'll use 2 decimals for precision (e.g., 10.25 kg)
    const decimals = 2;
    const initialSupply = initialStockKg * (10 ** decimals);
    
    // Store a very short memo to avoid MEMO_TOO_LONG error
    // Hedera's memo field is limited to 100 bytes
    const shortMemo = `${productName} | Owner: ${ownerAccountId.toString()}`;
    
    // Create the token
    let transaction = new TokenCreateTransaction()
      .setTokenName(tokenName)
      .setTokenSymbol(symbol)
      .setDecimals(decimals) 
      .setInitialSupply(initialSupply)
      .setTreasuryAccountId(operatorAccountId) // Initially created by treasury
      .setAdminKey(operatorPublicKey) // Admin key for updates
      .setSupplyKey(operatorPublicKey) // Supply key for minting/burning
      .setSupplyType(TokenSupplyType.Infinite)
      .setTokenType(TokenType.FungibleCommon)
      .setTokenMemo(shortMemo) // Only store a short memo
      .freezeWith(client);

    // Sign with treasury key
    const signTx = await transaction.sign(operatorPrivateKey);
    
    // Submit to Hedera network
    const txResponse = await signTx.execute(client);
    
    // Get receipt
    const receipt = await txResponse.getReceipt(client);
    
    // Get token ID
    const tokenId = receipt.tokenId.toString();
    
    // Store token ownership information
    tokenOwnership[tokenId] = {
      ownerAccountId: ownerAccountId.toString(),
      createdAt: getCurrentTimestamp(),
      productName
    };
    
    // Store the full metadata separately in our server's memory
    tokenMetadata[tokenId] = {
      productName,
      type: 'PRODUCT_STOCK',
      unit: 'KG',
      ownerAccountId: ownerAccountId.toString(),
      createdAt: getCurrentTimestamp(),
      ...metadata
    };
    
    // Initialize balance tracking - initially all tokens are with the treasury
    if (!tokenBalances[tokenId]) {
      tokenBalances[tokenId] = {};
    }
    tokenBalances[tokenId][operatorAccountId.toString()] = initialStockKg;
    
    // If creator is different from operator and private key is provided,
    // associate and transfer tokens
    if (creatorAccountId && 
        creatorAccountId !== operatorAccountId.toString() && 
        ownerPrivateKey) {
      
      try {
        // First, associate the token with the creator's account using their key
        const associateTx = await new TokenAssociateTransaction()
          .setAccountId(ownerAccountId)
          .setTokenIds([tokenId])
          .freezeWith(client)
          .sign(ownerPrivateKey); // Sign with owner's key
        
        const associateSubmit = await associateTx.execute(client);
        const associateReceipt = await associateSubmit.getReceipt(client);
        
        // Then transfer the tokens to the creator
        const transferTx = await new TransferTransaction()
          .addTokenTransfer(tokenId, operatorAccountId, -initialSupply) // Debit treasury
          .addTokenTransfer(tokenId, ownerAccountId, initialSupply) // Credit owner
          .freezeWith(client)
          .sign(operatorPrivateKey);
          
        const transferSubmit = await transferTx.execute(client);
        await transferSubmit.getReceipt(client);
        
        // Update balance tracking
        tokenBalances[tokenId][operatorAccountId.toString()] = 0;
        tokenBalances[tokenId][ownerAccountId.toString()] = initialStockKg;
        
        // Return success with transfer info
        return res.status(201).json({
          success: true,
          tokenId,
          tokenName,
          tokenSymbol: symbol,
          initialStockKg,
          ownerAccountId: ownerAccountId.toString(),
          balances: tokenBalances[tokenId],
          tokensTransferred: true,
          metadata: tokenMetadata[tokenId],
          message: `Token for ${productName} created successfully and transferred to account ${ownerAccountId}`
        });
      } catch (transferError) {
        // Check if it's a "token already associated" error and proceed with the transfer
        if (transferError.toString().includes('TOKEN_ALREADY_ASSOCIATED_WITH_ACCOUNT')) {
          try {
            // Token is already associated, proceed with transfer
            const transferTx = await new TransferTransaction()
              .addTokenTransfer(tokenId, operatorAccountId, -initialSupply) // Debit treasury
              .addTokenTransfer(tokenId, ownerAccountId, initialSupply) // Credit owner
              .freezeWith(client)
              .sign(operatorPrivateKey);
              
            const transferSubmit = await transferTx.execute(client);
            await transferSubmit.getReceipt(client);
            
            // Update balance tracking
            tokenBalances[tokenId][operatorAccountId.toString()] = 0;
            tokenBalances[tokenId][ownerAccountId.toString()] = initialStockKg;
            
            return res.status(201).json({
              success: true,
              tokenId,
              tokenName,
              tokenSymbol: symbol,
              initialStockKg,
              ownerAccountId: ownerAccountId.toString(),
              balances: tokenBalances[tokenId],
              tokensTransferred: true,
              metadata: tokenMetadata[tokenId],
              message: `Token for ${productName} created successfully and transferred to account ${ownerAccountId} (already associated)`
            });
          } catch (secondTransferError) {
            console.error("Token already associated but transfer failed:", secondTransferError);
            return res.status(201).json({
              success: true,
              tokenId,
              tokenName,
              tokenSymbol: symbol,
              initialStockKg,
              ownerAccountId: ownerAccountId.toString(),
              tokensTransferred: false,
              metadata: tokenMetadata[tokenId],
              error: `Token created but could not transfer to owner: ${secondTransferError.message}`,
              message: `Token for ${productName} created successfully but remains with treasury account`
            });
          }
        }
        
        // If transfer fails for other reasons, return token info but note the transfer failure
        console.error("Token created but transfer failed:", transferError);
        return res.status(201).json({
          success: true,
          tokenId,
          tokenName,
          tokenSymbol: symbol,
          initialStockKg,
          ownerAccountId: ownerAccountId.toString(),
          tokensTransferred: false,
          metadata: tokenMetadata[tokenId],
          error: `Token created but could not transfer to owner: ${transferError.message}`,
          message: `Token for ${productName} created successfully but remains with treasury account`
        });
      }
    }
    
    // Return success response with token ID and ownership info
    res.status(201).json({
      success: true,
      tokenId,
      tokenName,
      tokenSymbol: symbol,
      initialStockKg,
      ownerAccountId: ownerAccountId.toString(),
      tokensTransferred: false,
      balances: tokenBalances[tokenId],
      metadata: tokenMetadata[tokenId],
      message: ownerAccountId.toString() !== operatorAccountId.toString()
        ? `Token for ${productName} created successfully. Owner should associate token ${tokenId} with their account to receive tokens.`
        : `Token for ${productName} created successfully and owned by treasury account.`
    });
    
  } catch (error) {
    console.error("Error creating token:", error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to create token'
    });
  }
});

// Endpoint to associate a token with an account
app.post('/api/tokens/associate', async (req, res) => {
  try {
    const { tokenId, accountId, privateKey } = req.body;
    
    if (!tokenId || !accountId || !privateKey) {
      return res.status(400).json({ 
        error: 'Token ID, account ID and private key are required' 
      });
    }
    
    const { client } = getClient();
    
    try {
      // Parse the private key
      const key = PrivateKey.fromString(privateKey);
      const account = AccountId.fromString(accountId);
      
      // Create and execute the associate transaction
      const transaction = await new TokenAssociateTransaction()
        .setAccountId(account)
        .setTokenIds([tokenId])
        .freezeWith(client)
        .sign(key);
        
      const txResponse = await transaction.execute(client);
      const receipt = await txResponse.getReceipt(client);
      
      // Initialize balance tracking for this account with zero balance
      if (!tokenBalances[tokenId]) {
        tokenBalances[tokenId] = {};
      }
      tokenBalances[tokenId][accountId] = 0;
      
      res.status(200).json({
        success: true,
        tokenId,
        accountId,
        message: `Token ${tokenId} successfully associated with account ${accountId}`
      });
    } catch (error) {
      // Special handling for "already associated" errors
      if (error.toString().includes('TOKEN_ALREADY_ASSOCIATED_WITH_ACCOUNT')) {
        if (!tokenBalances[tokenId]) {
          tokenBalances[tokenId] = {};
        }
        tokenBalances[tokenId][accountId] = 0; // Initialize with zero
        
        return res.status(200).json({
          success: true,
          tokenId,
          accountId,
          message: `Token ${tokenId} was already associated with account ${accountId}`
        });
      }
      
      throw error;
    }
    
  } catch (error) {
    console.error("Error associating token:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to associate token'
    });
  }
});

// POST endpoint to update stock (increase/mint)
app.post('/api/tokens/mint', async (req, res) => {
  try {
    const { 
      tokenId, 
      amountKg, 
      accountId
    } = req.body;
    
    if (!tokenId || amountKg === undefined || amountKg <= 0) {
      return res.status(400).json({ error: 'Token ID and positive amount in kg are required' });
    }
    
    const { client, operatorPrivateKey, operatorAccountId } = getClient();

    // Verify ownership if accountId is provided
    if (accountId && tokenOwnership[tokenId] && 
        tokenOwnership[tokenId].ownerAccountId !== accountId) {
      return res.status(403).json({ 
        error: 'Unauthorized: Only the token owner can add stock' 
      });
    }

    // Get token info to check decimals
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
      
    const decimals = tokenInfo.decimals;
    // Convert kg to token units
    const amount = amountKg * (10 ** decimals);
    
    // Mint additional tokens (add stock)
    const mintTx = await new TokenMintTransaction()
      .setTokenId(tokenId)
      .setAmount(amount)
      .freezeWith(client)
      .sign(operatorPrivateKey);
      
    const mintTxSubmit = await mintTx.execute(client);
    const mintRx = await mintTxSubmit.getReceipt(client);
    
    // Initialize or update the treasury's balance
    if (!tokenBalances[tokenId]) {
      tokenBalances[tokenId] = {};
    }
    const treasuryBalance = tokenBalances[tokenId][operatorAccountId.toString()] || 0;
    tokenBalances[tokenId][operatorAccountId.toString()] = treasuryBalance + amountKg;
    
    // If the owner is different from the operator, attempt to transfer the new tokens
    if (tokenOwnership[tokenId] && 
        tokenOwnership[tokenId].ownerAccountId !== operatorAccountId.toString()) {
            
      const ownerAccount = AccountId.fromString(tokenOwnership[tokenId].ownerAccountId);
      
      try {
        const transferTx = await new TransferTransaction()
          .addTokenTransfer(tokenId, operatorAccountId, -amount) // Debit treasury
          .addTokenTransfer(tokenId, ownerAccount, amount) // Credit owner
          .freezeWith(client)
          .sign(operatorPrivateKey);
          
        const transferSubmit = await transferTx.execute(client);
        await transferSubmit.getReceipt(client);
        
        // Update balances
        if (!tokenBalances[tokenId][ownerAccount.toString()]) {
          tokenBalances[tokenId][ownerAccount.toString()] = 0;
        }
        tokenBalances[tokenId][operatorAccountId.toString()] = treasuryBalance;
        tokenBalances[tokenId][ownerAccount.toString()] += amountKg;
        
        // Return success with transfer info
        return res.status(200).json({
          success: true,
          tokenId,
          addedStockKg: amountKg,
          ownerAccountId: tokenOwnership[tokenId].ownerAccountId,
          tokensTransferred: true,
          balances: tokenBalances[tokenId],
          transactionId: mintTxSubmit.transactionId.toString(),
          message: `Successfully added ${amountKg} kg to stock and transferred to owner`
        });
      } catch (transferError) {
        // If it's a TOKEN_NOT_ASSOCIATED error, provide instructions
        if (transferError.toString().includes('TOKEN_NOT_ASSOCIATED_TO_ACCOUNT')) {
          return res.status(200).json({
            success: true,
            tokenId,
            addedStockKg: amountKg,
            ownerAccountId: tokenOwnership[tokenId].ownerAccountId,
            tokensTransferred: false,
            balances: tokenBalances[tokenId],
            transactionId: mintTxSubmit.transactionId.toString(),
            message: `Successfully added ${amountKg} kg to stock. The token is currently held by the treasury account. Owner must associate token ${tokenId} with their account ${ownerAccount.toString()} to receive tokens.`
          });
        } else {
          // For other errors, throw and let the general handler catch it
          throw transferError;
        }
      }
    }
    
    // If we reach here, either transfer wasn't needed or it's held by treasury account
    res.status(200).json({
      success: true,
      tokenId,
      addedStockKg: amountKg,
      ownerAccountId: tokenOwnership[tokenId]?.ownerAccountId || 'unknown',
      tokensTransferred: false,
      balances: tokenBalances[tokenId],
      transactionId: mintTxSubmit.transactionId.toString(),
      message: `Successfully added ${amountKg} kg to stock`
    });
    
  } catch (error) {
    console.error("Error adding stock:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to add stock'
    });
  }
});

// POST endpoint to reduce stock (burn)
app.post('/api/tokens/burn', async (req, res) => {
  try {
    const { 
      tokenId, 
      amountKg, 
      accountId
    } = req.body;
    
    if (!tokenId || amountKg === undefined || amountKg <= 0) {
      return res.status(400).json({ error: 'Token ID and positive amount in kg are required' });
    }
    
    // Verify ownership if accountId is provided
    if (accountId && tokenOwnership[tokenId] && 
        tokenOwnership[tokenId].ownerAccountId !== accountId) {
      return res.status(403).json({ 
        error: 'Unauthorized: Only the token owner can reduce stock' 
      });
    }
    
    const { client, operatorPrivateKey } = getClient();

    // Get token info to check decimals and current supply
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
      
    const decimals = tokenInfo.decimals;
    // Convert kg to token units
    const amount = amountKg * (10 ** decimals);
    
    // Check if there's enough stock
    if (tokenInfo.totalSupply.toNumber() < amount) {
      return res.status(400).json({ 
        success: false,
        error: 'Insufficient stock',
        requestedReduction: amountKg,
        availableStockKg: tokenInfo.totalSupply.toNumber() / (10 ** decimals)
      });
    }
    
    // Burn tokens (reduce stock)
    const burnTx = await new TokenBurnTransaction()
      .setTokenId(tokenId)
      .setAmount(amount)
      .freezeWith(client)
      .sign(operatorPrivateKey);
      
    const burnTxSubmit = await burnTx.execute(client);
    const burnRx = await burnTxSubmit.getReceipt(client);
    
    // Update the balances - we need to determine who actually had the tokens that were burned
    // For simplicity, we'll reduce from the token owner's balance
    if (tokenBalances[tokenId]) {
      const ownerAccountId = tokenOwnership[tokenId].ownerAccountId;
      if (tokenBalances[tokenId][ownerAccountId]) {
        tokenBalances[tokenId][ownerAccountId] -= amountKg;
      }
    }
    
    // Refresh actual balances from network after burn
    await updateTokenBalances(tokenId);
    
    res.status(200).json({
      success: true,
      tokenId,
      reducedStockKg: amountKg,
      ownerAccountId: tokenOwnership[tokenId]?.ownerAccountId || 'unknown',
      balances: tokenBalances[tokenId] || {},
      transactionId: burnTxSubmit.transactionId.toString(),
      message: `Successfully reduced stock by ${amountKg} kg`
    });
    
  } catch (error) {
    console.error("Error reducing stock:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reduce stock'
    });
  }
});

// POST endpoint to sell/transfer stock to another account
app.post('/api/tokens/sell', async (req, res) => {
  try {
    const { 
      tokenId,
      amountKg, 
      sellerAccountId, 
      sellerPrivateKey,
      buyerAccountId,
      buyerPrivateKey
    } = req.body;
    
    if (!tokenId || !buyerAccountId || !sellerAccountId || amountKg === undefined || amountKg <= 0) {
      return res.status(400).json({ 
        error: 'Token ID, seller account ID, buyer account ID, and positive amount in kg are required' 
      });
    }
    
    // Either sellerPrivateKey or buyerPrivateKey is required for token association
    if (!sellerPrivateKey && !buyerPrivateKey) {
      return res.status(400).json({
        error: 'Either seller or buyer private key is required for token association'
      });
    }
    
    // Verify ownership if token is in our records
    if (tokenOwnership[tokenId] && 
        tokenOwnership[tokenId].ownerAccountId !== sellerAccountId) {
      return res.status(403).json({ 
        error: 'Unauthorized: Only the token owner can sell stock' 
      });
    }
    
    const { client, operatorPrivateKey } = getClient();
    
    // Get token info for decimals
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
      
    const decimals = tokenInfo.decimals;
    const amount = amountKg * (10 ** decimals);
    
    const sellerAccount = AccountId.fromString(sellerAccountId);
    const buyerAccount = AccountId.fromString(buyerAccountId);
    
    // Parse private keys if provided
    let sellerKey = null;
    let buyerKey = null;
    
    if (sellerPrivateKey) {
      try {
        sellerKey = PrivateKey.fromString(sellerPrivateKey);
      } catch (err) {
        return res.status(400).json({
          error: 'Invalid seller private key format',
          details: err.message
        });
      }
    }
    
    if (buyerPrivateKey) {
      try {
        buyerKey = PrivateKey.fromString(buyerPrivateKey);
      } catch (err) {
        return res.status(400).json({
          error: 'Invalid buyer private key format',
          details: err.message
        });
      }
    }
    
    // Initialize balance tracking
    if (!tokenBalances[tokenId]) {
      tokenBalances[tokenId] = {};
    }
    if (!tokenBalances[tokenId][buyerAccountId]) {
      tokenBalances[tokenId][buyerAccountId] = 0;
    }
    if (!tokenBalances[tokenId][sellerAccountId]) {
      tokenBalances[tokenId][sellerAccountId] = 0;
    }
    
    // Try to associate the token with buyer account if buyer key is provided
    // If association fails with TOKEN_ALREADY_ASSOCIATED_WITH_ACCOUNT, we'll proceed with the transfer
    let needsAssociation = true;
    
    if (buyerKey) {
      try {
        // First check if already associated by querying account info
        const accountInfo = await new AccountBalanceQuery()
          .setAccountId(buyerAccount)
          .execute(client);
        
        // If token appears in the account's token map, it's already associated
        if (accountInfo.tokens && accountInfo.tokens._map.has(tokenId)) {
          console.log(`Token ${tokenId} is already associated with buyer account ${buyerAccountId}`);
          needsAssociation = false;
        }
      } catch (error) {
        console.warn(`Could not check if token ${tokenId} is associated with account ${buyerAccountId}: ${error.message}`);
        // Continue with association attempt
      }
      
      // Only try to associate if needed
      if (needsAssociation) {
        try {
          console.log(`Attempting to associate token ${tokenId} with buyer account ${buyerAccountId}`);
          
          const associateTx = await new TokenAssociateTransaction()
            .setAccountId(buyerAccount)
            .setTokenIds([tokenId])
            .freezeWith(client)
            .sign(buyerKey);
            
          const associateSubmit = await associateTx.execute(client);
          await associateSubmit.getReceipt(client);
          
          console.log(`Successfully associated token ${tokenId} with buyer account ${buyerAccountId}`);
        } catch (associateError) {
          // If it's already associated, that's fine - proceed with transfer
          if (associateError.toString().includes('TOKEN_ALREADY_ASSOCIATED_WITH_ACCOUNT')) {
            console.log(`Token ${tokenId} was already associated with buyer account ${buyerAccountId}`);
          } else {
            // For other errors, we should stop
            throw associateError;
          }
        }
      }
    }
    
    // Proceed with token transfer regardless of association status
    // Create a transaction for token transfer
    let transferTx = new TransferTransaction()
      .addTokenTransfer(tokenId, sellerAccount, -amount) // Debit from seller
      .addTokenTransfer(tokenId, buyerAccount, amount);  // Credit to buyer
    
    // Freeze the transaction
    let frozenTx = await transferTx.freezeWith(client);
    
    // Sign with required keys
    if (sellerKey) {
      frozenTx = await frozenTx.sign(sellerKey);
    }
    
    if (buyerKey) {
      frozenTx = await frozenTx.sign(buyerKey);
    }
    
    // If neither seller nor buyer key can sign for transfers, use operator key (for testing only)
    if (!sellerKey && !buyerKey) {
      frozenTx = await frozenTx.sign(operatorPrivateKey);
      console.warn("Using operator key for token transfer. In production, this should be signed by the seller or buyer.");
    }
    
    // Execute the transaction
    const txSubmit = await frozenTx.execute(client);
    const receipt = await txSubmit.getReceipt(client);
    
    // Update balances based on the transfer
    tokenBalances[tokenId][sellerAccountId] -= amountKg;
    tokenBalances[tokenId][buyerAccountId] += amountKg;
    
    // If this was a full transfer of all tokens, update the ownership
    const totalSupply = tokenInfo.totalSupply.toNumber() / (10 ** decimals);
    if (amountKg === totalSupply) {
      tokenOwnership[tokenId] = {
        ...tokenOwnership[tokenId],
        ownerAccountId: buyerAccountId,
        previousOwnerAccountId: sellerAccountId,
        lastTransferredAt: getCurrentTimestamp()
      };
    }
    
    res.status(200).json({
      success: true,
      tokenId,
      amountKg,
      fromAccount: sellerAccountId,
      toAccount: buyerAccountId,
      balances: tokenBalances[tokenId],
      transactionId: txSubmit.transactionId.toString(),
      message: `Successfully transferred ${amountKg} kg to account ${buyerAccountId}`
    });
    
  } catch (error) {
    console.error("Error selling stock:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to sell stock'
    });
  }
});

// GET endpoint to check token ownership
app.get('/api/tokens/ownership', async (req, res) => {
  try {
    const { tokenId } = req.query;
    
    if (!tokenId) {
      return res.status(400).json({
        error: 'Token ID is required as a query parameter'
      });
    }
    
    if (!tokenOwnership[tokenId]) {
      return res.status(404).json({ 
        error: `No ownership record found for token ID ${tokenId}` 
      });
    }
    
    res.status(200).json({
      success: true,
      tokenId,
      ownership: tokenOwnership[tokenId],
      timestamp: getCurrentTimestamp()
    });
    
  } catch (error) {
    console.error("Error checking token ownership:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check token ownership'
    });
  }
});

// GET endpoint to fetch all tokens owned by a specific account with stock information
app.get('/api/tokens/owned', async (req, res) => {
  try {
    const { accountId } = req.query;
    
    if (!accountId) {
      return res.status(400).json({
        error: 'Account ID is required as a query parameter'
      });
    }
    
    const { client } = getClient();
    
    // Get all token balances for this account from the Hedera network
    const balanceQuery = await new AccountBalanceQuery()
      .setAccountId(accountId)
      .execute(client);
    
    // Extract token relationships
    const tokenRelationships = balanceQuery.tokens._map;
    const ownedTokens = {};
    
    // Process each token the account has a relationship with
    for (const [tokenId, balance] of tokenRelationships.entries()) {
      try {
        // Get the token info from Hedera
        const tokenInfo = await new TokenInfoQuery()
          .setTokenId(tokenId)
          .execute(client);
          
        const decimals = tokenInfo.decimals;
        const stockKg = balance.toNumber() / (10 ** decimals);
        
        // Skip tokens with zero balance if desired
        // if (stockKg <= 0) continue;
        
        // Update our local tracking of balances
        if (!tokenBalances[tokenId]) {
          tokenBalances[tokenId] = {};
        }
        tokenBalances[tokenId][accountId] = stockKg;
        
        // Get ownership info if we have it, or create a placeholder
        let ownershipInfo = tokenOwnership[tokenId] || { 
          ownerAccountId: accountId,
          createdAt: getCurrentTimestamp(),
          productName: tokenInfo.name.replace(' Stock Token', '')
        };
        
        // Store ownership info if we didn't have it before
        if (!tokenOwnership[tokenId]) {
          tokenOwnership[tokenId] = ownershipInfo;
        }
        
        // Get metadata if we have it, or create a placeholder
        let metadataInfo = tokenMetadata[tokenId] || {
          productName: tokenInfo.name.replace(' Stock Token', ''),
          type: 'PRODUCT_STOCK',
          unit: 'KG',
          ownerAccountId: accountId,
          createdAt: getCurrentTimestamp()
        };
        
        // Store metadata if we didn't have it before
        if (!tokenMetadata[tokenId]) {
          tokenMetadata[tokenId] = metadataInfo;
        }
        
        ownedTokens[tokenId] = {
          tokenId,
          tokenName: tokenInfo.name,
          tokenSymbol: tokenInfo.symbol,
          currentStockKg: stockKg,
          metadata: metadataInfo,
          ownership: ownershipInfo
        };
      } catch (tokenError) {
        console.warn(`Could not fetch info for token ${tokenId}:`, tokenError.message);
      }
    }
    
    res.status(200).json({
      success: true,
      accountId,
      tokenCount: Object.keys(ownedTokens).length,
      tokens: ownedTokens,
      timestamp: getCurrentTimestamp()
    });
    
  } catch (error) {
    console.error("Error fetching owned tokens:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch owned tokens'
    });
  }
});
// GET endpoint to check token info and metadata
app.get('/api/tokens/info', async (req, res) => {
  try {
    const { tokenId } = req.query;
    
    if (!tokenId) {
      return res.status(400).json({ error: 'Token ID is required as a query parameter' });
    }
    
    const { client } = getClient();

    // Query token info
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
      
    const decimals = tokenInfo.decimals;
    const totalStockKg = tokenInfo.totalSupply.toNumber() / (10 ** decimals);
    
    // Get metadata from our server's memory store
    const metadata = tokenMetadata[tokenId] || {};
    
    // Include ownership information if available
    const ownershipInfo = tokenOwnership[tokenId] || { 
      ownerAccountId: metadata.ownerAccountId || 'unknown' 
    };
    
    // Get updated balances
    const balances = await updateTokenBalances(tokenId) || {};
    
    res.status(200).json({
      success: true,
      tokenId,
      tokenName: tokenInfo.name,
      tokenSymbol: tokenInfo.symbol,
      totalSupply: totalStockKg,
      balances: balances,
      ownerAccountId: ownershipInfo.ownerAccountId,
      memo: tokenInfo.tokenMemo,
      metadata: metadata,
      timestamp: getCurrentTimestamp()
    });
    
  } catch (error) {
    console.error("Error checking token info:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check token info'
    });
  }
});

// POST endpoint to update token metadata (stored locally, not on Hedera)
app.post('/api/tokens/metadata', async (req, res) => {
  try {
    const { tokenId, metadata } = req.body;
    
    if (!tokenId || !metadata) {
      return res.status(400).json({ error: 'Token ID and metadata are required' });
    }
    
    // Check if token exists in our records
    if (!tokenMetadata[tokenId] && !tokenOwnership[tokenId]) {
      // Try to query the token on Hedera to see if it exists
      try {
        const { client } = getClient();
        await new TokenInfoQuery().setTokenId(tokenId).execute(client);
        // If we reach here, token exists on Hedera but not in our records
        tokenMetadata[tokenId] = metadata;
      } catch (error) {
        return res.status(404).json({ error: `Token ${tokenId} not found` });
      }
    } else {
      // Update existing metadata
      tokenMetadata[tokenId] = {
        ...tokenMetadata[tokenId],
        ...metadata,
        updatedAt: getCurrentTimestamp()
      };
    }
    
    res.status(200).json({
      success: true,
      tokenId,
      metadata: tokenMetadata[tokenId],
      message: `Metadata for token ${tokenId} updated successfully`,
      timestamp: getCurrentTimestamp()
    });
    
  } catch (error) {
    console.error("Error updating token metadata:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update token metadata'
    });
  }
});

// GET check if token exists
app.get('/api/tokens/exists', async (req, res) => {
  try {
    const { tokenId } = req.query;
    
    if (!tokenId) {
      return res.status(400).json({ error: 'Token ID is required as a query parameter' });
    }
    
    const { client } = getClient();

    try {
      // Try to get token info from Hedera
      const tokenInfo = await new TokenInfoQuery()
        .setTokenId(tokenId)
        .execute(client);
        
      // Token exists
      res.status(200).json({
        success: true,
        tokenId,
        exists: true,
        tokenName: tokenInfo.name,
        tokenSymbol: tokenInfo.symbol,
        timestamp: getCurrentTimestamp()
      });
    } catch (error) {
      // Token doesn't exist or is inaccessible
      res.status(200).json({
        success: true,
        tokenId,
        exists: false,
        error: error.message,
        timestamp: getCurrentTimestamp()
      });
    }
  } catch (error) {
    console.error("Error checking token existence:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check token existence'
    });
  }
});

// GET all tokens (for admin purposes)
app.get('/api/tokens/all', async (req, res) => {
  try {
    // Prepare response with ownership and metadata
    const tokens = {};
    
    for (const tokenId in tokenOwnership) {
      // Try to get the latest balances
      await updateTokenBalances(tokenId);
      
      tokens[tokenId] = {
        ...tokenOwnership[tokenId],
        metadata: tokenMetadata[tokenId] || {},
        balances: tokenBalances[tokenId] || {}
      };
    }
    
    res.status(200).json({
      success: true,
      tokensCount: Object.keys(tokens).length,
      tokens: tokens,
      timestamp: getCurrentTimestamp()
    });
  } catch (error) {
    console.error("Error fetching all tokens:", error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch token list'
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Product Stock Token API running on port ${PORT}`);
});