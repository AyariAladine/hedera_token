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

app.use(express.json());
app.use(cors());

const tokenOwnership = {};
const tokenMetadata = {}; 
const tokenBalances = {};  

function getCurrentTimestamp() {
  return new Date().toISOString();
}

function getClient() {
  const myAccountId = AccountId.fromString(process.env.MY_ACCOUNT_ID);
  const myPrivateKey = PrivateKey.fromString(process.env.MY_PRIVATE_KEY);

  const client = Client.forTestnet(); 
  client.setOperator(myAccountId, myPrivateKey);
  
  return {
    client,
    operatorPrivateKey: myPrivateKey,
    operatorPublicKey: myPrivateKey.publicKey, 
    operatorAccountId: myAccountId
  };
}

async function updateTokenBalances(tokenId) {
  try {
    const { client } = getClient();
    
    if (!tokenBalances[tokenId]) {
      tokenBalances[tokenId] = {};
    }
    
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

app.post('/api/tokens/create', async (req, res) => {
  try {
    const { 
      productName, 
      initialStockKg,
      creatorAccountId,
      creatorPrivateKey,
      metadata = {} 
    } = req.body;
    
    if (!productName || initialStockKg === undefined) {
      return res.status(400).json({ error: 'Missing required parameters: productName, initialStockKg' });
    }

    const { client, operatorPrivateKey, operatorPublicKey, operatorAccountId } = getClient();
    
    const ownerAccountId = creatorAccountId ? AccountId.fromString(creatorAccountId) : operatorAccountId;
    
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

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    
    const tokenName = `${productName} Stock Token`;
    

    const symbol = `${productName.substring(0, 4).toUpperCase()}-${timestamp.slice(-4)}`;
    

    const decimals = 2;
    const initialSupply = initialStockKg * (10 ** decimals);
    

    const shortMemo = `${productName} | Owner: ${ownerAccountId.toString()}`;
    
    let transaction = new TokenCreateTransaction()
      .setTokenName(tokenName)
      .setTokenSymbol(symbol)
      .setDecimals(decimals) 
      .setInitialSupply(initialSupply)
      .setTreasuryAccountId(operatorAccountId) 
      .setAdminKey(operatorPublicKey) 
      .setSupplyKey(operatorPublicKey) 
      .setSupplyType(TokenSupplyType.Infinite)
      .setTokenType(TokenType.FungibleCommon)
      .setTokenMemo(shortMemo) 
      .freezeWith(client);

    const signTx = await transaction.sign(operatorPrivateKey);
    const txResponse = await signTx.execute(client);
    const receipt = await txResponse.getReceipt(client);
    const tokenId = receipt.tokenId.toString();
    tokenOwnership[tokenId] = {
      ownerAccountId: ownerAccountId.toString(),
      createdAt: getCurrentTimestamp(),
      productName
    };
    
    tokenMetadata[tokenId] = {
      productName,
      type: 'PRODUCT_STOCK',
      unit: 'KG',
      ownerAccountId: ownerAccountId.toString(),
      createdAt: getCurrentTimestamp(),
      ...metadata
    };
    
    if (!tokenBalances[tokenId]) {
      tokenBalances[tokenId] = {};
    }
    tokenBalances[tokenId][operatorAccountId.toString()] = initialStockKg;
    

    if (creatorAccountId && 
        creatorAccountId !== operatorAccountId.toString() && 
        ownerPrivateKey) {
      
      try {
        const associateTx = await new TokenAssociateTransaction()
          .setAccountId(ownerAccountId)
          .setTokenIds([tokenId])
          .freezeWith(client)
          .sign(ownerPrivateKey); 
        
        const associateSubmit = await associateTx.execute(client);
        const associateReceipt = await associateSubmit.getReceipt(client);
        
        const transferTx = await new TransferTransaction()
          .addTokenTransfer(tokenId, operatorAccountId, -initialSupply) 
          .addTokenTransfer(tokenId, ownerAccountId, initialSupply) 
          .freezeWith(client)
          .sign(operatorPrivateKey);
          
        const transferSubmit = await transferTx.execute(client);
        await transferSubmit.getReceipt(client);
        
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
          message: `Token for ${productName} created successfully and transferred to account ${ownerAccountId}`
        });
      } catch (transferError) {
        if (transferError.toString().includes('TOKEN_ALREADY_ASSOCIATED_WITH_ACCOUNT')) {
          try {
            const transferTx = await new TransferTransaction()
              .addTokenTransfer(tokenId, operatorAccountId, -initialSupply) 
              .addTokenTransfer(tokenId, ownerAccountId, initialSupply) 
              .freezeWith(client)
              .sign(operatorPrivateKey);
              
            const transferSubmit = await transferTx.execute(client);
            await transferSubmit.getReceipt(client);
            
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
      const key = PrivateKey.fromString(privateKey);
      const account = AccountId.fromString(accountId);
      
      const transaction = await new TokenAssociateTransaction()
        .setAccountId(account)
        .setTokenIds([tokenId])
        .freezeWith(client)
        .sign(key);
        
      const txResponse = await transaction.execute(client);
      const receipt = await txResponse.getReceipt(client);
      
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
      if (error.toString().includes('TOKEN_ALREADY_ASSOCIATED_WITH_ACCOUNT')) {
        if (!tokenBalances[tokenId]) {
          tokenBalances[tokenId] = {};
        }
        tokenBalances[tokenId][accountId] = 0; 
        
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

    if (accountId && tokenOwnership[tokenId] && 
        tokenOwnership[tokenId].ownerAccountId !== accountId) {
      return res.status(403).json({ 
        error: 'Unauthorized: Only the token owner can add stock' 
      });
    }

    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
      
    const decimals = tokenInfo.decimals;
    const amount = amountKg * (10 ** decimals);
    
    const mintTx = await new TokenMintTransaction()
      .setTokenId(tokenId)
      .setAmount(amount)
      .freezeWith(client)
      .sign(operatorPrivateKey);
      
    const mintTxSubmit = await mintTx.execute(client);
    const mintRx = await mintTxSubmit.getReceipt(client);
    
    if (!tokenBalances[tokenId]) {
      tokenBalances[tokenId] = {};
    }
    const treasuryBalance = tokenBalances[tokenId][operatorAccountId.toString()] || 0;
    tokenBalances[tokenId][operatorAccountId.toString()] = treasuryBalance + amountKg;
    
    if (tokenOwnership[tokenId] && 
        tokenOwnership[tokenId].ownerAccountId !== operatorAccountId.toString()) {
            
      const ownerAccount = AccountId.fromString(tokenOwnership[tokenId].ownerAccountId);
      
      try {
        const transferTx = await new TransferTransaction()
          .addTokenTransfer(tokenId, operatorAccountId, -amount)
          .addTokenTransfer(tokenId, ownerAccount, amount) 
          .freezeWith(client)
          .sign(operatorPrivateKey);
          
        const transferSubmit = await transferTx.execute(client);
        await transferSubmit.getReceipt(client);
        
        if (!tokenBalances[tokenId][ownerAccount.toString()]) {
          tokenBalances[tokenId][ownerAccount.toString()] = 0;
        }
        tokenBalances[tokenId][operatorAccountId.toString()] = treasuryBalance;
        tokenBalances[tokenId][ownerAccount.toString()] += amountKg;
        
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
          throw transferError;
        }
      }
    }
    
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
    
    if (accountId && tokenOwnership[tokenId] && 
        tokenOwnership[tokenId].ownerAccountId !== accountId) {
      return res.status(403).json({ 
        error: 'Unauthorized: Only the token owner can reduce stock' 
      });
    }
    
    const { client, operatorPrivateKey } = getClient();

    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
      
    const decimals = tokenInfo.decimals;
    const amount = amountKg * (10 ** decimals);
    
    if (tokenInfo.totalSupply.toNumber() < amount) {
      return res.status(400).json({ 
        success: false,
        error: 'Insufficient stock',
        requestedReduction: amountKg,
        availableStockKg: tokenInfo.totalSupply.toNumber() / (10 ** decimals)
      });
    }
    
    const burnTx = await new TokenBurnTransaction()
      .setTokenId(tokenId)
      .setAmount(amount)
      .freezeWith(client)
      .sign(operatorPrivateKey);
      
    const burnTxSubmit = await burnTx.execute(client);
    const burnRx = await burnTxSubmit.getReceipt(client);

    if (tokenBalances[tokenId]) {
      const ownerAccountId = tokenOwnership[tokenId].ownerAccountId;
      if (tokenBalances[tokenId][ownerAccountId]) {
        tokenBalances[tokenId][ownerAccountId] -= amountKg;
      }
    }
    
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
    
    if (!sellerPrivateKey && !buyerPrivateKey) {
      return res.status(400).json({
        error: 'Either seller or buyer private key is required for token association'
      });
    }
    
    if (tokenOwnership[tokenId] && 
        tokenOwnership[tokenId].ownerAccountId !== sellerAccountId) {
      return res.status(403).json({ 
        error: 'Unauthorized: Only the token owner can sell stock' 
      });
    }
    
    const { client, operatorPrivateKey } = getClient();
    
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
      
    const decimals = tokenInfo.decimals;
    const amount = amountKg * (10 ** decimals);
    
    const sellerAccount = AccountId.fromString(sellerAccountId);
    const buyerAccount = AccountId.fromString(buyerAccountId);
    
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
    
    if (!tokenBalances[tokenId]) {
      tokenBalances[tokenId] = {};
    }
    if (!tokenBalances[tokenId][buyerAccountId]) {
      tokenBalances[tokenId][buyerAccountId] = 0;
    }
    if (!tokenBalances[tokenId][sellerAccountId]) {
      tokenBalances[tokenId][sellerAccountId] = 0;
    }
    
     let needsAssociation = true;
    
    if (buyerKey) {
      try {
        const accountInfo = await new AccountBalanceQuery()
          .setAccountId(buyerAccount)
          .execute(client);
        
        if (accountInfo.tokens && accountInfo.tokens._map.has(tokenId)) {
          console.log(`Token ${tokenId} is already associated with buyer account ${buyerAccountId}`);
          needsAssociation = false;
        }
      } catch (error) {
        console.warn(`Could not check if token ${tokenId} is associated with account ${buyerAccountId}: ${error.message}`);
      }
      
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
          if (associateError.toString().includes('TOKEN_ALREADY_ASSOCIATED_WITH_ACCOUNT')) {
            console.log(`Token ${tokenId} was already associated with buyer account ${buyerAccountId}`);
          } else {
            throw associateError;
          }
        }
      }
    }

    let transferTx = new TransferTransaction()
      .addTokenTransfer(tokenId, sellerAccount, -amount) 
      .addTokenTransfer(tokenId, buyerAccount, amount);  
    
    let frozenTx = await transferTx.freezeWith(client);
    
    if (sellerKey) {
      frozenTx = await frozenTx.sign(sellerKey);
    }
    
    if (buyerKey) {
      frozenTx = await frozenTx.sign(buyerKey);
    }
    
    if (!sellerKey && !buyerKey) {
      frozenTx = await frozenTx.sign(operatorPrivateKey);
      console.warn("Using operator key for token transfer. In production, this should be signed by the seller or buyer.");
    }
    
    const txSubmit = await frozenTx.execute(client);
    const receipt = await txSubmit.getReceipt(client);
    
    tokenBalances[tokenId][sellerAccountId] -= amountKg;
    tokenBalances[tokenId][buyerAccountId] += amountKg;
    
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

app.get('/api/tokens/owned', async (req, res) => {
  try {
    const { accountId } = req.query;
    
    if (!accountId) {
      return res.status(400).json({
        error: 'Account ID is required as a query parameter'
      });
    }
    
    const { client } = getClient();
    
    const balanceQuery = await new AccountBalanceQuery()
      .setAccountId(accountId)
      .execute(client);
    
    const tokenRelationships = balanceQuery.tokens._map;
    const ownedTokens = {};
    
    for (const [tokenId, balance] of tokenRelationships.entries()) {
      try {
        const tokenInfo = await new TokenInfoQuery()
          .setTokenId(tokenId)
          .execute(client);
          
        const decimals = tokenInfo.decimals;
        const stockKg = balance.toNumber() / (10 ** decimals);
        
 
        
        if (!tokenBalances[tokenId]) {
          tokenBalances[tokenId] = {};
        }
        tokenBalances[tokenId][accountId] = stockKg;
        
        let ownershipInfo = tokenOwnership[tokenId] || { 
          ownerAccountId: accountId,
          createdAt: getCurrentTimestamp(),
          productName: tokenInfo.name.replace(' Stock Token', '')
        };
        
        if (!tokenOwnership[tokenId]) {
          tokenOwnership[tokenId] = ownershipInfo;
        }
        
        let metadataInfo = tokenMetadata[tokenId] || {
          productName: tokenInfo.name.replace(' Stock Token', ''),
          type: 'PRODUCT_STOCK',
          unit: 'KG',
          ownerAccountId: accountId,
          createdAt: getCurrentTimestamp()
        };
        
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
app.get('/api/tokens/info', async (req, res) => {
  try {
    const { tokenId } = req.query;
    
    if (!tokenId) {
      return res.status(400).json({ error: 'Token ID is required as a query parameter' });
    }
    
    const { client } = getClient();

    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
      
    const decimals = tokenInfo.decimals;
    const totalStockKg = tokenInfo.totalSupply.toNumber() / (10 ** decimals);
    
    const metadata = tokenMetadata[tokenId] || {};
    
    const ownershipInfo = tokenOwnership[tokenId] || { 
      ownerAccountId: metadata.ownerAccountId || 'unknown' 
    };
    
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

app.post('/api/tokens/metadata', async (req, res) => {
  try {
    const { tokenId, metadata } = req.body;
    
    if (!tokenId || !metadata) {
      return res.status(400).json({ error: 'Token ID and metadata are required' });
    }
    
    if (!tokenMetadata[tokenId] && !tokenOwnership[tokenId]) {
      try {
        const { client } = getClient();
        await new TokenInfoQuery().setTokenId(tokenId).execute(client);
        tokenMetadata[tokenId] = metadata;
      } catch (error) {
        return res.status(404).json({ error: `Token ${tokenId} not found` });
      }
    } else {
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

app.get('/api/tokens/exists', async (req, res) => {
  try {
    const { tokenId } = req.query;
    
    if (!tokenId) {
      return res.status(400).json({ error: 'Token ID is required as a query parameter' });
    }
    
    const { client } = getClient();

    try {
      const tokenInfo = await new TokenInfoQuery()
        .setTokenId(tokenId)
        .execute(client);
        
      res.status(200).json({
        success: true,
        tokenId,
        exists: true,
        tokenName: tokenInfo.name,
        tokenSymbol: tokenInfo.symbol,
        timestamp: getCurrentTimestamp()
      });
    } catch (error) {
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

app.get('/api/tokens/all', async (req, res) => {
  try {
    const tokens = {};
    
    for (const tokenId in tokenOwnership) {
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

app.listen(PORT, () => {
  console.log(`Product Stock Token API running on port ${PORT}`);
});