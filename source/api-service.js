// Example API service
import axios from 'axios';

const API_BASE = process.env.API_URL || 'http://localhost:3000/api';

export const userService = {
  async getUser(id) {
    const response = await axios.get(`${API_BASE}/users/${id}`);
    return response.data;
  },

  async updateUser(id, data) {
    if (!data || !id) {
      throw new Error('Invalid user data');
    }
    const response = await axios.put(`${API_BASE}/users/${id}`, data);
    return response.data;
  },

  async deleteUser(id) {
    const response = await axios.delete(`${API_BASE}/users/${id}`);
    return response.data;
  }
};