import test from 'node:test';
import assert from 'node:assert/strict';
import { account, normalize, distance, password } from '../backend/validation.js';
test('normalizes customer names and validates accounts',()=>{assert.equal(normalize(' 王　小明 '),'王小明');assert.deepEqual(account({name:'销售员',username:'Sales_01'}),{name:'销售员',username:'sales_01'});});
test('rejects short passwords',()=>assert.throws(()=>password('short')));
test('compares avatar dHash distance',()=>assert.equal(distance('ff00','ff01'),1));

